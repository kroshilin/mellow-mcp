import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMatchedFreelancersTools } from "../../src/tools/scout/matched-freelancers";

type CapturedCall = { method: string; path: string; body?: unknown };

function makeServerStub() {
	type Handler = (params: unknown) => Promise<unknown>;
	const tools = new Map<string, Handler>();
	const server = {
		tool(name: string, _description: string, _schema: unknown, _annotations: unknown, handler: Handler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;
	return {
		server,
		invoke: (name: string, params: unknown) => {
			const handler = tools.get(name);
			if (!handler) throw new Error(`tool not registered: ${name}`);
			return handler(params);
		},
	};
}

function makeClientStub(responses: Record<string, unknown>) {
	const calls: CapturedCall[] = [];
	const respond = (method: string, path: string) => {
		// Sort by descending key length so longer/more-specific path prefixes win
		// over shorter ones — prevents MF-2..MF-5 deep-path tests from silently
		// matching the shorter list-path key when both startsWith() succeed.
		const matches = Object.keys(responses)
			.filter((k) => {
				const [m, p] = k.split(" ");
				return m === method && path.startsWith(p);
			})
			.sort((a, b) => b.length - a.length);
		if (matches.length === 0) {
			throw new Error(`no scripted response for ${method} ${path}; available: ${Object.keys(responses).join(", ")}`);
		}
		return responses[matches[0]];
	};
	const stub = {
		get: async (path: string) => { calls.push({ method: "GET", path }); return respond("GET", path); },
		post: async (path: string, body?: object) => { calls.push({ method: "POST", path, body }); return respond("POST", path); },
		put: async (path: string, body?: object) => { calls.push({ method: "PUT", path, body }); return respond("PUT", path); },
		patch: async (path: string, body?: object) => { calls.push({ method: "PATCH", path, body }); return respond("PATCH", path); },
		del: async (path: string, body?: object) => { calls.push({ method: "DELETE", path, body }); return respond("DELETE", path); },
	};
	return { stub, calls };
}

describe("scout_listMatchedFreelancers", () => {
	it("GETs /positions/{positionId}/matched-freelancers and returns the wrapped envelope", async () => {
		const positionId = "00000000-0000-0000-0000-000000000001";
		const { stub, calls } = makeClientStub({
			[`GET /positions/${positionId}/matched-freelancers`]: {
				status: "completed",
				matches: [
					{
						matchId: "11111111-1111-1111-1111-111111111111",
						score: 95.0,
						explanation: "Strong PHP background, matches stack",
						status: "new",
						profile: {
							email: "test@example.com",
							firstName: "Иван",
							lastName: "Иванов",
							expertiseArea: "Backend PHP",
							residenceCountry: "RU",
							educationLevel: 3,
							educationCertificatesLinks: [],
							experienceYears: 7,
							completedProjectsCount: 42,
							portfolioLinks: ["https://github.com/test"],
							referralRate: 5000,
							cvFileLink: null,
						},
					},
				],
			},
		});
		const { server, invoke } = makeServerStub();
		registerMatchedFreelancersTools(server, stub as never);

		const result = (await invoke("scout_listMatchedFreelancers", { positionId })) as {
			structuredContent: Record<string, unknown>;
		};

		expect(calls).toEqual([{ method: "GET", path: `/positions/${positionId}/matched-freelancers` }]);
		expect(result.structuredContent.status).toBe("completed");
		expect(Array.isArray(result.structuredContent.matches)).toBe(true);
	});
});
