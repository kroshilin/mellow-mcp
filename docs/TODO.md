# MCP improvements backlog

Non-blocking tasks deferred from QA sessions. Pick one at a time when there's bandwidth.

---

## B — Rewrite HTTP-code-leaking tool descriptions in agent-first style

**Deferred from:** session 2026-05-19 ("createTask description sweep").

**Problem:** ~13 tool descriptions reference raw HTTP status codes (`HTTP 400`, `HTTP 409`, `HTTP 422`, etc.). The agent technically sees these codes inside our `MellowClient` error string (`Mellow API X /path failed (NNN) [trace=...]`) and can branch on them, but the descriptions read like backend-integration docs instead of operator instructions for an agent that calls MCP tools.

**Affected lines:**

- `src/tools/freelancers.ts:96` — `inviteFreelancer` (HTTP 422, HTTP 423)
- `src/tools/freelancers.ts:156` — `findFreelancerByPhone` (404, HTTP 403)
- `src/tools/freelancers.ts:193` — `editFreelancerProfile` (HTTP 409)
- `src/tools/freelancers.ts:225` — `removeFreelancer` (HTTP 422, HTTP 200)
- `src/tools/freelancers.ts:241` — `getFreelancerTaxInfo` (HTTP 404)
- `src/tools/scout/applications.ts:93` — `scout_inviteApplicant` (HTTP 409)
- `src/tools/tasks.ts:113` — `createTask.title` field (HTTP 422)
- `src/tools/tasks.ts:132` — `createTask.uuid` field (HTTP 400)
- `src/tools/tasks.ts:214` — `changeTaskStatus` (HTTP 400)
- `src/tools/tasks.ts:235` — `changeDeadline` (HTTP 400)
- `src/tools/tasks.ts:287` — `payForTask` (HTTP 400)
- `src/tools/tasks.ts:386` — `addTaskFiles` (HTTP 400)
- `src/tools/f2b/clients.ts:140` — `f2b_archiveClient` (HTTP 422)

**Rewrite pattern:**

| before | after |
|---|---|
| `Returns HTTP 422 'already in team'` | `If the freelancer is already in this company, the call fails — surface 'already in team' to the user` |
| `those return HTTP 400` | `the call will fail in those states` |
| `Otherwise HTTP 400` | `Otherwise the call fails` |

**Keep as-is:**

- `src/agent-primer.ts:76, 120-123` — the HTTP-code-to-meaning map is reference material for error-handling, useful for the agent to know how to interpret the MellowClient error string.

**Estimate:** ~1 hour, single-PR sweep, type-check + grep verify.
