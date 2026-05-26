import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCompanyPrompts, registerFreelancerPrompts } from "../../src/prompts";

// Unit tests for MCP prompts. Strategy: stub registerPrompt, capture all
// registrations, invoke each callback with a sample args object, and
// assert the rendered prompt text mentions the right tool / workflow / recipe.
//
// We don't lock in the verbatim text (it's expected to evolve as recipes
// change). We assert that the key references that make the prompt useful are
// present: tool names that drive the flow, the workflow recipe number, and
// critical safety phrases ("two-step", "confirm before").

type PromptCallback = (args: Record<string, unknown>) => { messages: Array<{ role: string; content: { type: string; text: string } }> };
type RegisteredPrompt = { name: string; config: Record<string, unknown>; cb: PromptCallback };

function makeServerStub() {
  const prompts: RegisteredPrompt[] = [];
  const server = {
    registerPrompt(name: string, config: Record<string, unknown>, cb: PromptCallback) {
      prompts.push({ name, config, cb });
    },
  } as unknown as McpServer;
  return {
    server,
    prompts,
    get: (name: string) => {
      const p = prompts.find((x) => x.name === name);
      if (!p) throw new Error(`prompt not registered: ${name}`);
      return p;
    },
  };
}

describe("company-mode prompts", () => {
  it("registers exactly four prompts: create_first_task, accept_and_pay, cancel_task, scout_matching_review", () => {
    const { server, prompts } = makeServerStub();
    registerCompanyPrompts(server);
    expect(prompts.map((p) => p.name).sort()).toEqual(["accept_and_pay", "cancel_task", "create_first_task", "scout_matching_review"]);
  });

  describe("create_first_task", () => {
    it("renders a single user-role text message", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const result = get("create_first_task").cb({});
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");
    });

    it("mentions the critical tools and the recipe", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("create_first_task").cb({}).messages[0].content.text;
      expect(text).toMatch(/Recipe 1/);
      for (const tool of [
        "inviteFreelancer",
        "getServices",
        "getTaskAttributes",
        "getCompanyBalance",
        "createTask",
        "getTask",
        "publishDraftTask",
      ]) {
        expect(text).toContain(tool);
      }
    });

    it("optionally embeds the freelancerHint when provided", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("create_first_task").cb({ freelancerHint: "ivan@example.com" }).messages[0].content.text;
      expect(text).toContain("ivan@example.com");
    });
  });

  describe("accept_and_pay", () => {
    it("flags the two-step semantics + ANTI_PATTERNS A1", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("accept_and_pay").cb({}).messages[0].content.text;
      expect(text).toMatch(/Recipe 3/);
      // The two-step semantics rule: acceptTask is separate from payForTask.
      expect(text).toMatch(/acceptTask.*only moves|separate `payForTask`/);
      expect(text).toMatch(/ANTI_PATTERNS A1/);
      for (const tool of ["getTask", "acceptTask", "getCompanyBalance", "payForTask"]) {
        expect(text).toContain(tool);
      }
    });

    it("embeds taskUuid when provided + asks for it otherwise", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const withUuid = get("accept_and_pay").cb({ taskUuid: "11111111-1111-1111-1111-111111111111" }).messages[0].content.text;
      expect(withUuid).toContain("11111111-1111-1111-1111-111111111111");
      const without = get("accept_and_pay").cb({}).messages[0].content.text;
      expect(without).toMatch(/ask me for the task UUID/i);
    });
  });

  describe("cancel_task", () => {
    it("documents both decline paths (direct NEW/DRAFT + two-step via 11) and the soft-cancel framing", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("cancel_task").cb({}).messages[0].content.text;
      expect(text).toMatch(/Recipe 17/);
      expect(text).toMatch(/Recipe 5/);
      expect(text).toMatch(/ANTI_PATTERNS A2/);
      expect(text).toMatch(/soft/i);
      expect(text).toMatch(/no hard-delete/i);
      for (const tool of ["getTask", "declineTask"]) {
        expect(text).toContain(tool);
      }
    });
  });

  describe("scout_matching_review", () => {
    it("mentions polling cadence, all matched-freelancers tools, and Recipe 13", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("scout_matching_review").cb({}).messages[0].content.text;
      expect(text).toMatch(/Recipe 13/);
      expect(text).toMatch(/3-5/); // polling cadence
      for (const tool of [
        "scout_listMatchedFreelancers",
        "scout_markMatchedFreelancerViewed",
        "scout_inviteMatchedFreelancer",
        "scout_requestMatching",
      ]) {
        expect(text).toContain(tool);
      }
    });

    it("reminds about the Scout ↔ CoR boundary", () => {
      const { server, get } = makeServerStub();
      registerCompanyPrompts(server);
      const text = get("scout_matching_review").cb({}).messages[0].content.text;
      expect(text).toMatch(/inviteFreelancer/); // CoR side, mentioned as the bridge to contractual work
    });
  });
});

describe("freelancer-mode prompts", () => {
  it("registers exactly one prompt: f2b_issue_invoice", () => {
    const { server, prompts } = makeServerStub();
    registerFreelancerPrompts(server);
    expect(prompts.map((p) => p.name)).toEqual(["f2b_issue_invoice"]);
  });

  describe("f2b_issue_invoice", () => {
    it("makes the two-step send invariant + ANTI_PATTERNS M1 explicit", () => {
      const { server, get } = makeServerStub();
      registerFreelancerPrompts(server);
      const text = get("f2b_issue_invoice").cb({}).messages[0].content.text;
      expect(text).toMatch(/two-step/);
      expect(text).toMatch(/ANTI_PATTERNS M1/);
      // Don't-call-send-without-breakdown rule. Wording softened from CAPS NEVER
      // to lowercase "don't" — assertion matches both.
      expect(text).toMatch(/don't call.*f2b_sendInvoiceDraft.*without|first showing me the breakdown/);
      expect(text).toMatch(/Recipe 14/);
      for (const tool of ["f2b_listClients", "f2b_createInvoiceDraft", "f2b_sendInvoiceDraft"]) {
        expect(text).toContain(tool);
      }
    });

    it("warns about hard-coding commission (ANTI_PATTERNS M2)", () => {
      const { server, get } = makeServerStub();
      registerFreelancerPrompts(server);
      const text = get("f2b_issue_invoice").cb({}).messages[0].content.text;
      expect(text).toMatch(/ANTI_PATTERNS M2/);
      expect(text).toMatch(/hard-code/);
    });

    it("embeds clientId when provided + falls back to listClients otherwise", () => {
      const { server, get } = makeServerStub();
      registerFreelancerPrompts(server);
      const withId = get("f2b_issue_invoice").cb({ clientId: 6659 }).messages[0].content.text;
      expect(withId).toContain("6659");
      const without = get("f2b_issue_invoice").cb({}).messages[0].content.text;
      expect(without).toContain("f2b_listClients");
    });
  });
});
