import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MellowClient } from "../mellow-client";

interface SearchResult {
  id: string;
  title: string;
  text: string;
}

function formatTaskResult(task: Record<string, unknown>): SearchResult {
  const id = task.id ?? task.uuid;
  const title = (task.title as string) ?? "Untitled Task";
  const parts = [
    task.state !== undefined ? `Status: ${task.state}` : null,
    task.price !== undefined ? `Price: ${task.price}` : null,
    task.workerFullName ? `Worker: ${task.workerFullName}` : null,
    task.dateEnd ? `Deadline: ${task.dateEnd}` : null,
    task.description ? `Description: ${String(task.description).slice(0, 200)}` : null,
  ].filter(Boolean);

  return {
    id: `task:${id}`,
    title,
    text: parts.join(", "),
  };
}

function formatFreelancerResult(freelancer: Record<string, unknown>): SearchResult {
  const id = freelancer.id ?? freelancer.uuid;
  const name = [freelancer.firstName, freelancer.lastName].filter(Boolean).join(" ") || "Unknown";
  const parts = [
    freelancer.email ? `Email: ${freelancer.email}` : null,
    freelancer.isVerified !== undefined ? `Verified: ${freelancer.isVerified}` : null,
    freelancer.specialization ? `Specialization: ${freelancer.specialization}` : null,
    freelancer.taxationStatus ? `Tax status: ${freelancer.taxationStatus}` : null,
  ].filter(Boolean);

  return {
    id: `freelancer:${id}`,
    title: name,
    text: parts.join(", "),
  };
}

function matchesQuery(query: string, freelancer: Record<string, unknown>): boolean {
  const lower = query.toLowerCase();
  const name = [freelancer.firstName, freelancer.lastName, freelancer.middleName].filter(Boolean).join(" ").toLowerCase();
  const email = ((freelancer.email as string) ?? "").toLowerCase();

  return name.includes(lower) || email.includes(lower);
}

function parseCompositeId(id: string): { type: string; numericId: string } {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid resource ID format: "${id}". Expected format: type:id (e.g. task:123)`);
  }

  return {
    type: id.slice(0, colonIndex),
    numericId: id.slice(colonIndex + 1),
  };
}

export function registerChatGptTools(server: McpServer, client: MellowClient) {
  server.tool(
    "search",
    "Search across tasks and freelancers. Returns a list of results with IDs that can be used with the fetch tool to get full details.",
    {
      query: z.string().describe("Search query"),
    },
    { title: "Search tasks and freelancers", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ query }) => {
      const results: SearchResult[] = [];

      const taskSearch = client
        .get<{ items?: Record<string, unknown>[] }>("/customer/tasks", {
          "filter[search]": query,
          size: "10",
        })
        .then((response) => {
          const items = response?.items ?? (Array.isArray(response) ? response : []);
          for (const task of items) {
            results.push(formatTaskResult(task));
          }
        })
        .catch((error) => {
          console.error("Task search failed:", error);
        });

      const freelancerSearch = client
        .get<{ items?: Record<string, unknown>[] }>("/customer/freelancers", {
          size: "20",
        })
        .then((response) => {
          const items = response?.items ?? (Array.isArray(response) ? response : []);
          const matched = items.filter((f) => matchesQuery(query, f));
          for (const freelancer of matched) {
            results.push(formatFreelancerResult(freelancer));
          }
        })
        .catch((error) => {
          console.error("Freelancer search failed:", error);
        });

      await Promise.all([taskSearch, freelancerSearch]);

      return {
        // Hand-built object literal — already a record, no asStructuredObject wrap needed.
        structuredContent: { results } as { [key: string]: unknown },
        content: [
          {
            text: JSON.stringify({ results }, null, 2),
            type: "text" as const,
          },
        ],
      };
    },
  );

  server.tool(
    "fetch",
    "Fetch full details of a resource by its composite ID (e.g. task:123, freelancer:456). Use IDs returned by the search tool.",
    {
      id: z.string().describe("Resource ID from search results (e.g. task:123, freelancer:456)"),
    },
    { title: "Fetch resource by ID", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ id }) => {
      const { type, numericId } = parseCompositeId(id);

      let result: unknown;
      let title: string;

      switch (type) {
        case "task": {
          result = await client.get(`/customer/tasks/${numericId}`);
          title = ((result as Record<string, unknown>)?.title as string) ?? `Task ${numericId}`;
          break;
        }
        case "freelancer": {
          result = await client.get(`/customer/freelancers/${numericId}`);
          const f = result as Record<string, unknown>;
          title = [f.firstName, f.lastName].filter(Boolean).join(" ") || `Freelancer ${numericId}`;
          break;
        }
        case "company": {
          result = await client.get(`/user/company/${numericId}/balance`);
          title = `Company ${numericId}`;
          break;
        }
        default:
          return {
            content: [
              {
                text: JSON.stringify({
                  error: `Unknown resource type: "${type}". Supported types: task, freelancer, company`,
                }),
                type: "text" as const,
              },
            ],
            isError: true,
          };
      }

      const payload = {
        id,
        title,
        text: JSON.stringify(result, null, 2),
        metadata: { type },
      };

      return {
        // Hand-built object literal — already a record, no asStructuredObject wrap needed.
        structuredContent: payload as { [key: string]: unknown },
        content: [
          {
            text: JSON.stringify(payload, null, 2),
            type: "text" as const,
          },
        ],
      };
    },
  );
}
