import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asStructuredList, asStructuredObject, type MellowClient } from "../mellow-client";

export function registerTaskTools(server: McpServer, client: MellowClient) {
  server.tool(
    "listTasks",
    "Search and retrieve tasks with filters (pagination, date ranges, price, state, etc.)",
    {
      search: z.string().optional().describe("Search task title/description"),
      workerId: z.number().optional().describe("Filter by worker ID"),
      creatorId: z.number().optional().describe("Filter by creator ID"),
      companyId: z.number().optional().describe("Filter by company ID"),
      state: z.array(z.number()).optional().describe("Filter by task states (array of state IDs)"),
      groupId: z.number().optional().describe("Filter by task group ID"),
      currencyId: z.number().optional().describe("Filter by currency ID"),
      dateCreatedFrom: z.string().optional().describe("Filter tasks created from date (YYYY-MM-DD)"),
      dateCreatedTo: z.string().optional().describe("Filter tasks created to date (YYYY-MM-DD)"),
      dateEndFrom: z.string().optional().describe("Filter by end date from"),
      dateEndTo: z.string().optional().describe("Filter by end date to"),
      dateFinishedFrom: z.string().optional().describe("Filter by finished date from"),
      dateFinishedTo: z.string().optional().describe("Filter by finished date to"),
      dateAcceptedFrom: z.string().optional().describe("Filter by accepted date from"),
      dateAcceptedTo: z.string().optional().describe("Filter by accepted date to"),
      datePaidFrom: z.string().optional().describe("Filter by paid date from"),
      datePaidTo: z.string().optional().describe("Filter by paid date to"),
      priceFrom: z.number().optional().describe("Minimum price filter"),
      priceTo: z.number().optional().describe("Maximum price filter"),
      hasPayout: z.boolean().optional().describe("Filter by payout existence"),
      hasCopyright: z.boolean().optional().describe("Filter by copyright flag"),
      hasReport: z.boolean().optional().describe("Filter by report flag"),
      deadlineType: z.number().optional().describe("Filter by deadline type"),
      workerTaxationStatus: z.number().optional().describe("Filter by worker taxation status"),
      externalId: z.string().optional().describe("Filter by external ID"),
      payedBy: z.number().optional().describe("Filter by payer ID"),
      sort: z.enum(["date_end", "date_finished", "price"]).optional().describe("Sort field"),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      page: z.number().optional().describe("Page number"),
      size: z.number().max(500).optional().describe("Page size (max 500)"),
    },
    { title: "List tasks", readOnlyHint: true },
    async (params) => {
      const queryParams: Record<string, string | undefined> = {
        "filter[search]": params.search,
        "filter[workerId]": params.workerId?.toString(),
        "filter[creatorId]": params.creatorId?.toString(),
        "filter[companyId]": params.companyId?.toString(),
        "filter[groupId]": params.groupId?.toString(),
        "filter[currencyId]": params.currencyId?.toString(),
        "filter[dateCreatedFrom]": params.dateCreatedFrom,
        "filter[dateCreatedTo]": params.dateCreatedTo,
        "filter[dateEndFrom]": params.dateEndFrom,
        "filter[dateEndTo]": params.dateEndTo,
        "filter[dateFinishedFrom]": params.dateFinishedFrom,
        "filter[dateFinishedTo]": params.dateFinishedTo,
        "filter[dateAcceptedFrom]": params.dateAcceptedFrom,
        "filter[dateAcceptedTo]": params.dateAcceptedTo,
        "filter[datePaidFrom]": params.datePaidFrom,
        "filter[datePaidTo]": params.datePaidTo,
        "filter[priceFrom]": params.priceFrom?.toString(),
        "filter[priceTo]": params.priceTo?.toString(),
        "filter[hasPayout]": params.hasPayout?.toString(),
        "filter[hasCopyright]": params.hasCopyright?.toString(),
        "filter[hasReport]": params.hasReport?.toString(),
        "filter[deadlineType]": params.deadlineType?.toString(),
        "filter[workerTaxationStatus]": params.workerTaxationStatus?.toString(),
        "filter[externalId]": params.externalId,
        "filter[payedBy]": params.payedBy?.toString(),
        sort: params.sort,
        direction: params.direction,
        page: params.page?.toString(),
        size: params.size?.toString(),
      };

      // Handle state array - needs multiple filter[state][] params
      if (params.state?.length) {
        for (const s of params.state) {
          queryParams[`filter[state][]`] = s.toString();
        }
      }

      const result = await client.get<unknown>("/customer/tasks", queryParams);
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getTask",
    "Get detailed information about a specific task by ID or UUID",
    {
      taskId: z.string().describe("Task ID (numeric) or UUID string"),
    },
    { title: "Get task", readOnlyHint: true },
    async ({ taskId }) => {
      const result = await client.get<unknown>(`/customer/tasks/${taskId}`);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "createTask",
    "Create a task for a freelancer. Returns the new task UUID only — call getTask(uuid) right after to see the full task and its state. If the company balance covers the task cost, the task is published (NEW) and the freelancer sees it. If the balance is insufficient, the task is silently saved as DRAFT with no error — the user won't see it in their active tasks until they top up at https://my.mellow.io/ → Finances → Top up and you call publishDraftTask. Pre-check getCompanyBalance to know which path to expect. Title is normalized (em-dashes, curly quotes, NBSP) before send.",
    {
      title: z
        .string()
        .describe(
          'Task title (2–300 chars). Allowed: letters (any language), digits, whitespace, and special chars `- , . : ; ( ) _ " № % # @ ^ « »`. Em-dashes (—), en-dashes (–), curly quotes, slashes are rejected by the backend with HTTP 422 — this MCP normalizes the most common substitutions before sending.',
        ),
      description: z.string().describe("Task description"),
      workerId: z.number().describe("Freelancer worker ID"),
      categoryId: z
        .number()
        .describe(
          'Required service ID from getServices(). Despite the name `categoryId`, this expects a service (leaf), not its category (parent) — wrong type fails with "Service is not available".',
        ),
      price: z.number().describe("Task price"),
      deadline: z
        .string()
        .describe(
          "Task deadline. Prefer ISO-8601 with explicit timezone (e.g. 2026-05-01T15:00:00+00:00). If no TZ is given, server-default (UTC) is assumed.",
        ),
      uuid: z
        .string()
        .optional()
        .describe(
          "Optional client-generated UUID. NOT an idempotency key — duplicates return HTTP 400. For idempotent retries use externalId + listTasks(filter[externalId]=...).",
        ),
      attributes: z
        .array(z.object({ id: z.number(), value: z.string() }))
        .optional()
        .describe(
          "Task attributes (id + value pairs). Up to 8 are available; 3 are mandatory per category — fetch them via getTaskAttributes.",
        ),
      copyright: z.boolean().optional().describe("Whether copyright transfer is required"),
      needReport: z.boolean().optional().describe("Whether a report is needed"),
      fileIds: z.array(z.number()).optional().describe("IDs of files pre-uploaded via addTaskFiles. Not URLs, not base64."),
      externalId: z
        .string()
        .optional()
        .describe("External reference ID. Unique per (companyId, externalId). Use this for idempotent retries."),
      workerCurrency: z.string().optional().describe("ISO currency code for worker payment (USD, EUR, RUB, KZT)."),
      shareCommission: z.boolean().optional().describe("Share commission with worker"),
      validateOnly: z.boolean().optional().describe("Only run validators without writing — dry run."),
      acceptanceFileIds: z
        .array(z.number())
        .optional()
        .describe("IDs of acceptance documents the freelancer must sign. Look up via getAcceptanceDocuments."),
      editGroup: z
        .array(z.number())
        .optional()
        .describe("Task group ID. The field is an array for historical reasons — pass a single ID wrapped in an array: [groupId]."),
    },
    { title: "Create task" },
    async (params) => {
      // Defensive check for known-removed fields. MCP SDK's tool() takes a
      // ZodRawShape and wraps it in z.object() with default strip semantics,
      // so unknown keys are silently dropped — that masks agent migration
      // bugs (e.g. agent passes legacy `createType:'draft'` and gets a
      // silently-ignored no-op). Reject explicitly with the rename hint.
      const REMOVED_FIELDS: Record<string, string> = {
        createType:
          "removed — DRAFT vs NEW is now governed by company balance (silent DRAFT on insufficient funds); do not pass this field.",
        acceptanceFileTemplateIds: "renamed → use `acceptanceFileIds` instead.",
      };
      for (const [field, hint] of Object.entries(REMOVED_FIELDS)) {
        if (field in (params as Record<string, unknown>)) {
          throw new Error(`createTask: field '${field}' is no longer accepted — ${hint}`);
        }
      }

      // Normalize title to keep within the backend's special-char whitelist:
      // em/en-dash → hyphen, curly quotes → straight, NBSP/narrow-NBSP → regular space.
      // Curly singles and backticks are stripped (apostrophes are not on the whitelist).
      const normalizedTitle = params.title.replace(/[—–]/g, "-").replace(/[“”]/g, '"').replace(/[‘’`]/g, "").replace(/[  ]/g, " ");
      const result = await client.post<unknown>("/customer/tasks", { ...params, title: normalizedTitle });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "publishDraftTask",
    "Publish a draft task: moves it from DRAFT to NEW so the freelancer can see and accept it. Requires the company to have enough balance for the task — if the balance is insufficient, this call fails and the task stays in DRAFT. Call getCompanyBalance first; if the balance does not cover the task, point the user to https://my.mellow.io/ → Finances → Top up (wire transfer, 1-3 business days), then retry. Provide either taskId or uuid (not both).",
    {
      taskId: z.number().optional().describe("Task ID (numeric). Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
      companyId: z
        .number()
        .optional()
        .describe("Company ID. Optional — defaults to the active company context (X-Company-Id header or user default)."),
    },
    { title: "Publish draft task" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/publish-draft", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getAllowedCurrencies",
    "Get allowed currencies for multicurrency tasks for the active company. companyId is optional — if omitted, MCP defaults to the session's active company. Backend requires an explicit query param (ignores X-Company-Id on this endpoint); omitting both used to 400 before this default was added.",
    {
      companyId: z
        .number()
        .optional()
        .describe("Company ID. Optional — defaults to the session's active company (MCP-side, before sending)."),
    },
    { title: "Get allowed currencies", readOnlyHint: true },
    async ({ companyId }) => {
      // This endpoint ignores X-Company-Id and demands an explicit companyId query param.
      // Default from the session's active company so single-company users don't need to
      // pass it on every call.
      const effectiveCompanyId = companyId ?? client.activeCompanyId;
      if (effectiveCompanyId === undefined) {
        throw new Error("getAllowedCurrencies: companyId is required (no active company on session). Pass companyId explicitly.");
      }
      const result = await client.get<unknown>("/customer/tasks/allowed-currencies", { companyId: effectiveCompanyId.toString() });
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "changeTaskStatus",
    "Universal state transition endpoint. Only 4 values of 'state' are accepted: 2 (worker accepts), 3 (worker finishes), 6 (worker declines), 8 (customer confirms worker's decline). Any other value returns HTTP 400. Most of these are freelancer-side; for customer flows prefer dedicated tools (acceptTask, declineTask, resumeTask).",
    {
      taskId: z.string().describe("Task ID or UUID"),
      state: z
        .number()
        .describe(
          "2=worker accepts (NEW→IN_WORK), 3=worker finishes (IN_WORK→RESULT), 6=worker declines, 8=customer confirms worker's decline (WAITING_DECLINE_BY_WORKER→DECLINED_BY_CUSTOMER).",
        ),
    },
    { title: "Change task status" },
    async ({ taskId, state }) => {
      const result = await client.put<unknown>(`/customer/tasks/${taskId}`, { state });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "changeDeadline",
    "Extend a task's deadline. Only legal when the task is in WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14), the previous active state was NEW or IN_WORK, and the new deadline is in the future. Wrong state → HTTP 422 'Can not process task with current state'. Shortening is not supported.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
      deadline: z.string().describe("New deadline (ISO 8601 with timezone). Must be in the future."),
    },
    { title: "Extend task deadline" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/prolong-deadline", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "checkTaskRequirements",
    "Check if a freelancer meets task requirements before starting",
    {
      taskUuid: z.string().describe("Task UUID"),
      freelancerUuid: z.string().describe("Freelancer UUID"),
    },
    { title: "Check task requirements", readOnlyHint: true },
    async ({ taskUuid, freelancerUuid }) => {
      const result = await client.get<unknown>("/customer/freelancers/check-task-requirements", { taskUuid, freelancerUuid });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "acceptTask",
    "Accept the freelancer's submitted result. Transitions RESULT (3) → FOR_PAYMENT (4). Does NOT pay out — call payForTask as the next step. Also handles sub-paths from WAITING_DECLINE_BY_WORKER (11) / WAITING_FOR_CUSTOMER_DEADLINE_DECISION (14) into FOR_PAYMENT.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
    },
    { title: "Accept task result" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/accept", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "payForTask",
    "Trigger payout for a task already accepted. Legal only in FOR_PAYMENT (4). Transitions FOR_PAYMENT → PAYMENT_QUEUED (12); the final debit to FINISHED (5) is asynchronous. Returns HTTP 400 if balance is insufficient — pre-check getCompanyBalance.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
    },
    { title: "Pay for task" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/pay", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "declineTask",
    "Confirm the freelancer's decline request. Only valid when the task is in state WAITING_DECLINE_BY_WORKER (11) → transitions to DECLINED_BY_CUSTOMER (8). Does NOT cancel a live task — there is no single-call cancel.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
    },
    { title: "Confirm freelancer decline" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/decline", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "resumeTask",
    "Return a submitted task back to the freelancer for rework. Only valid from RESULT (3) → IN_WORK (2). Deadline is not auto-extended — if the old deadline has passed, the task may re-enter deadline-decision state.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
    },
    { title: "Resume task for rework" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/return-to-work", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "getTaskMessages",
    "Get all messages for a task. Pass either taskId (numeric) or uuid.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
      page: z.number().optional().describe("Page number (default 1)"),
      size: z.number().max(500).optional().describe("Page size (default 20, max 500)"),
      sort: z.string().optional().describe("Sort field (default 'id')"),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default 'desc' — newest first)"),
    },
    { title: "Get task messages", readOnlyHint: true },
    async (params) => {
      const id = params.taskId ?? params.uuid;
      const query: Record<string, string | undefined> = {
        page: params.page?.toString(),
        size: params.size?.toString(),
        sort: params.sort,
        direction: params.direction,
      };
      const result = await client.get<unknown>(`/tasks/${id}/messages`, query);
      return {
        structuredContent: asStructuredList(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "addTaskMessage",
    "Send a chat message into a task's thread. Pass either taskId (numeric) or uuid — when only uuid is given, MCP transparently looks up the numeric taskId via getTask first (the underlying endpoint POST /api/tasks/messages accepts only taskId, unlike other write tools). Returns 200 with empty body. Caller must have task-view permission for the task; 403 otherwise. Sender id is taken from the JWT, not from the body. No state guard — message goes through in any state.",
    {
      taskId: z.number().optional().describe("Task ID (numeric). Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId — MCP will resolve to numeric id before sending."),
      message: z.string().describe("Message text (recommend ≤ 5000 chars)"),
    },
    { title: "Add task message" },
    async (params) => {
      // Endpoint is /api/tasks/messages (NOT /api/customer/tasks/messages — that path
      // is method-mismatched with PUT /api/customer/tasks/{taskIdentifier} and produces 500).
      // The endpoint accepts only numeric taskId; uuid → 422 "taskId blank". When only
      // uuid is supplied, resolve to taskId via getTask first.
      let taskId = params.taskId;
      if (taskId === undefined && params.uuid !== undefined) {
        const task = (await client.get<{ id?: number }>(`/customer/tasks/${params.uuid}`)) ?? {};
        if (typeof task.id !== "number") {
          throw new Error(`addTaskMessage: could not resolve uuid '${params.uuid}' to numeric taskId`);
        }
        taskId = task.id;
      }
      if (taskId === undefined) {
        throw new Error("addTaskMessage: either taskId or uuid is required");
      }
      const result = await client.post<unknown>("/tasks/messages", { taskId, message: params.message });
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );

  server.tool(
    "addTaskFiles",
    "Upload a file attached to a task. Not allowed in FINISHED (5) or PAYMENT_QUEUED (12) — those return HTTP 400.",
    {
      taskId: z.number().optional().describe("Task ID. Provide this OR uuid."),
      uuid: z.string().optional().describe("Task UUID. Provide this OR taskId."),
      file: z.string().describe("Path to a local file; client reads and uploads as multipart/form-data."),
      type: z
        .number()
        .optional()
        .describe(
          "File type. Default 5 (TASKS_FILES — generic task attachment). Other values are reserved for system imports/documents and rarely needed.",
        ),
    },
    { title: "Add task files" },
    async (params) => {
      const result = await client.post<unknown>("/customer/tasks/files", params);
      return {
        structuredContent: asStructuredObject(result),
        content: [{ text: JSON.stringify(result, null, 2), type: "text" as const }],
      };
    },
  );
}
