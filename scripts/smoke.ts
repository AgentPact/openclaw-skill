import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCLAW_HELPER_TOOL_NAMES, OPENCLAW_HELPER_TOOLS } from "../src/helper-tools";

type RegisteredTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  optional?: boolean;
  execute: (params?: any) => Promise<unknown>;
};

type PluginRegister = (api: {
  registerTool: (tool: RegisteredTool) => void;
  hasRegisteredTool?: (name: string) => boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
}) => void;

type BuiltLiveToolsModule = {
  createLiveToolRuntime: (options?: {
    logger?: Pick<Console, "error" | "info">;
    agentFactory?: () => Promise<unknown> | unknown;
  }) => {
    getAgent(): Promise<unknown>;
    ensureStarted(): Promise<void>;
    drainEvents(maxEvents: number): Promise<{ events: Array<{ type: string; data: Record<string, unknown>; timestamp: number }>; remaining: number }>;
    serialize(value: unknown): string;
    formatError(error: unknown, context: string): unknown;
  };
  getSharedLiveToolNames: () => string[];
  registerOpenClawLiveTools: (
    api: {
      registerTool: (tool: RegisteredTool) => void;
    },
    runtime: {
      getAgent(): Promise<unknown>;
      ensureStarted(): Promise<void>;
      drainEvents(maxEvents: number): Promise<{ events: Array<{ type: string; data: Record<string, unknown>; timestamp: number }>; remaining: number }>;
      serialize(value: unknown): string;
      formatError(error: unknown, context: string): unknown;
    }
  ) => void;
};

function parseToolText(result: unknown) {
  const text = (result as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
    (item) => item?.type === "text"
  )?.text;
  assert.ok(typeof text === "string" && text.length > 0, "tool result did not include text content");
  return text;
}

function parseToolJson(result: unknown) {
  return JSON.parse(parseToolText(result));
}

class FakePluginApi {
  readonly tools = new Map<string, RegisteredTool>();
  readonly logs: string[] = [];

  constructor(private readonly conflictNames = new Set<string>()) {}

  readonly logger = {
    info: (message?: unknown) => {
      this.logs.push(`info:${String(message ?? "")}`);
    },
    warn: (message?: unknown) => {
      this.logs.push(`warn:${String(message ?? "")}`);
    },
    error: (message?: unknown) => {
      this.logs.push(`error:${String(message ?? "")}`);
    },
  };

  hasRegisteredTool = (name: string) => {
    return this.conflictNames.has(name) || this.tools.has(name);
  };

  registerTool(tool: RegisteredTool) {
    assert.ok(!this.tools.has(tool.name), `duplicate tool registration detected for ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  getTool(name: string) {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool not registered: ${name}`);
    return tool;
  }
}

async function importBuiltPlugin(): Promise<PluginRegister> {
  const pluginPath = pathToFileURL(path.resolve(process.cwd(), "dist/index.js")).href;
  const module = await import(pluginPath);
  const register = (module.default ?? module) as PluginRegister;
  assert.equal(typeof register, "function", "dist/index.js did not export a plugin register function");
  return register;
}

async function importBuiltLiveTools() {
  const liveToolsPath = pathToFileURL(
    path.resolve(process.cwd(), "..", "live-tools", "dist", "index.js")
  ).href;
  const module = await import(liveToolsPath) as BuiltLiveToolsModule;
  return module;
}

function getStructuredContent<T>(result: unknown, key: string) {
  const structured = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;
  assert.ok(structured && typeof structured === "object", "tool result did not include structured content");
  const value = structured[key];
  assert.ok(value !== undefined, `tool result did not include structured content key: ${key}`);
  return value as T;
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function withSmokeEnvironment<T>(run: (ctx: {
  rootDir: string;
  openclawStateDir: string;
  workspaceRoot: string;
}) => Promise<T>) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpact-openclaw-smoke-"));
  const openclawStateDir = path.join(rootDir, ".openclaw");
  const workspaceRoot = path.join(rootDir, "workspace");
  const configPath = path.join(openclawStateDir, "openclaw.json");
  const envPath = path.join(openclawStateDir, ".env");

  const previousEnv = {
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
    AGENTPACT_AGENT_PK: process.env.AGENTPACT_AGENT_PK,
    AGENTPACT_PLATFORM: process.env.AGENTPACT_PLATFORM,
  };

  try {
    await fs.mkdir(openclawStateDir, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          plugins: {
            entries: {
              agentpact: {
                enabled: true,
              },
            },
          },
          agents: {
            defaults: {
              workspace: workspaceRoot,
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(envPath, "AGENTPACT_AGENT_PK=0xsmoketest\n", "utf8");

    process.env.OPENCLAW_HOME = rootDir;
    process.env.OPENCLAW_STATE_DIR = openclawStateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    delete process.env.OPENCLAW_PROFILE;
    process.env.AGENTPACT_AGENT_PK = "0xsmoketest";
    process.env.AGENTPACT_PLATFORM = "http://127.0.0.1:4000";

    return await run({ rootDir, openclawStateDir, workspaceRoot });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function runActiveRegistrationScenario(register: PluginRegister, liveToolNames: string[]) {
  return withSmokeEnvironment(async ({ workspaceRoot }) => {
    const api = new FakePluginApi();
    register(api);

    for (const helperName of OPENCLAW_HELPER_TOOL_NAMES) {
      assert.ok(api.tools.has(helperName), `helper tool missing: ${helperName}`);
    }
    for (const liveToolName of liveToolNames) {
      assert.ok(api.tools.has(liveToolName), `live tool missing: ${liveToolName}`);
    }

    const capabilityCatalog = parseToolJson(
      await api.getTool(OPENCLAW_HELPER_TOOLS.capabilityCatalog).execute({})
    ) as {
      liveToolCount: number;
      helperToolCount: number;
      helperTools: string[];
    };
    assert.equal(capabilityCatalog.liveToolCount, liveToolNames.length, "capability catalog live tool count mismatch");
    assert.equal(capabilityCatalog.helperToolCount, OPENCLAW_HELPER_TOOL_NAMES.length, "capability catalog helper count mismatch");
    assert.deepEqual([...capabilityCatalog.helperTools].sort(), [...OPENCLAW_HELPER_TOOL_NAMES].sort(), "capability catalog helper list mismatch");

    const helpText = parseToolText(await api.getTool(OPENCLAW_HELPER_TOOLS.help).execute({}));
    assert.match(helpText, /Live tools via plugin: ACTIVE/, "help output should confirm active plugin-side live tools");

    const status = parseToolJson(await api.getTool(OPENCLAW_HELPER_TOOLS.status).execute({})) as {
      pluginEntryPresent: boolean;
      openclawEnvExists: boolean;
      workspaceRoot: string;
      summary: { issues?: string[]; nextSteps?: string[]; notes?: string[] };
    };
    assert.equal(status.pluginEntryPresent, true, "status tool did not detect plugin entry");
    assert.equal(status.openclawEnvExists, true, "status tool did not detect env file");
    assert.equal(status.workspaceRoot, workspaceRoot, "status tool workspace root mismatch");

    const stateGet = parseToolJson(await api.getTool(OPENCLAW_HELPER_TOOLS.stateGet).execute({})) as {
      statePath: string;
      state: { recentTaskIds: string[] };
    };
    assert.equal(await pathExists(stateGet.statePath), true, "state file was not created on read");

    const workspaceInit = parseToolJson(
      await api.getTool(OPENCLAW_HELPER_TOOLS.workspaceInit).execute({
        taskId: "task-smoke-001",
        escrowId: "42",
        category: "SOFTWARE",
        difficulty: "MEDIUM",
        reward: "0.5 ETH",
        status: "selected",
        summary: "Smoke test task workspace",
        publicMaterials: ["README", "spec.md"],
        confidentialMaterials: ["private-brief.md"],
      })
    ) as {
      taskRoot: string;
      taskJsonPath: string;
      summaryPath: string;
      proposalPath: string;
      manifestPath: string;
      notesPath: string;
    };

    for (const createdPath of [
      workspaceInit.taskRoot,
      workspaceInit.taskJsonPath,
      workspaceInit.summaryPath,
      workspaceInit.proposalPath,
      workspaceInit.manifestPath,
      workspaceInit.notesPath,
    ]) {
      assert.equal(await pathExists(createdPath), true, `workspace path missing: ${createdPath}`);
    }

    const heartbeatPlan = parseToolJson(
      await api.getTool(OPENCLAW_HELPER_TOOLS.heartbeatPlan).execute({})
    ) as {
      plan: { priority: string; suggestedActions: string[] };
    };
    assert.equal(heartbeatPlan.plan.priority, "pending_assignments", "heartbeat plan should prioritize pending assignments after workspace init");

    return {
      registeredToolCount: api.tools.size,
      helperToolCount: OPENCLAW_HELPER_TOOL_NAMES.length,
      liveToolCount: liveToolNames.length,
    };
  });
}

async function runMcpConflictScenario(register: PluginRegister) {
  return withSmokeEnvironment(async () => {
    const api = new FakePluginApi(new Set(["agentpact_get_available_tasks"]));
    register(api);

    assert.equal(api.tools.has("agentpact_get_available_tasks"), false, "plugin should not register live tools when MCP conflict is detected");
    for (const helperName of OPENCLAW_HELPER_TOOL_NAMES) {
      assert.ok(api.tools.has(helperName), `helper tool missing under MCP conflict: ${helperName}`);
    }

    const helpText = parseToolText(await api.getTool(OPENCLAW_HELPER_TOOLS.help).execute({}));
    assert.match(helpText, /Live tools via plugin: DEFERRED \(MCP server detected\)/, "help output should confirm MCP conflict deferral");

    return {
      registeredToolCount: api.tools.size,
    };
  });
}

class MockWorkflowAgent {
  private readonly handlers = new Map<string, Array<(event: { type: string; data: Record<string, unknown> }) => void>>();
  private readonly node = {
    id: "node-smoke-001",
    displayName: "Smoke Node",
    automationMode: "ASSISTED",
    status: "ACTIVE",
  };
  private readonly task = {
    id: "task-host-001",
    title: "Host workflow smoke task",
    status: "WORKING",
    access: {
      assignmentRole: "claimed_provider",
      canSelectedNodeClaim: false,
    },
    workflow: {
      deliveryStage: "AWAITING_DELIVERY",
    },
  };
  private run = {
    id: "run-smoke-001",
    taskId: "task-host-001",
    workerKey: "openclaw:smoke-worker",
    hostKind: "OPENCLAW",
    status: "RUNNING",
    percent: 0,
    currentStep: "Task context loaded",
    summary: "Execution session started for Host workflow smoke task",
  };
  private approval = {
    id: "approval-smoke-001",
    taskId: "task-host-001",
    workerRunId: "run-smoke-001",
    kind: "STRATEGY_DECISION",
    status: "PENDING",
    title: "Need owner approval before publish step",
    summary: "Publish step touches an external endpoint." as string | null,
    effectiveDueAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    timeoutWindowMinutes: 45,
    timeoutSource: "policy_default",
    isOverdue: false,
    responseNote: undefined as string | undefined,
  };

  on(event: string, handler: (event: { type: string; data: Record<string, unknown> }) => void) {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return () => {
      const next = (this.handlers.get(event) ?? []).filter((item) => item !== handler);
      this.handlers.set(event, next);
    };
  }

  async start() {
    return;
  }

  async startWorkerTaskSession(params: { taskId: string; workerKey: string; hostKind: string; currentStep?: string; summary?: string }) {
    this.run = {
      ...this.run,
      taskId: params.taskId,
      workerKey: params.workerKey,
      hostKind: params.hostKind,
      status: "RUNNING",
      currentStep: params.currentStep ?? "Task context loaded",
      summary: params.summary ?? this.run.summary,
      percent: 0,
    };

    return {
      node: this.node,
      run: this.run,
      task: this.task,
      brief: {
        task: this.task,
        node: this.node,
        workerRuns: [this.run],
        pendingApprovals: [],
        clarifications: [],
        unreadChatCount: 0,
        recentMessages: [],
        suggestedNextActions: ["Continue execution and report progress at the next milestone."],
      },
    };
  }

  async resumeWorkerTaskSession(params: { taskId: string; currentStep?: string; summary?: string }) {
    this.run = {
      ...this.run,
      taskId: params.taskId,
      currentStep: params.currentStep ?? "Worker session resumed",
      summary: params.summary ?? this.run.summary,
    };

    return {
      node: this.node,
      run: this.run,
      task: this.task,
      brief: {
        task: this.task,
        node: this.node,
        workerRuns: [this.run],
        pendingApprovals: [],
        clarifications: [],
        unreadChatCount: 0,
        recentMessages: [],
        suggestedNextActions: ["Resume execution."],
      },
      reusedExistingRun: true,
    };
  }

  async gateWorkerRunForApproval(params: { kind: string; title: string; summary?: string; runSummary?: string }) {
    this.run = {
      ...this.run,
      status: "WAITING_APPROVAL",
      currentStep: "Waiting for node-owner approval",
      summary: params.runSummary ?? params.summary ?? params.title,
      percent: 42,
    };
    this.approval = {
      ...this.approval,
      kind: params.kind,
      title: params.title,
      summary: params.summary ?? null,
      status: "PENDING",
    };

    return {
      run: this.run,
      approval: this.approval,
    };
  }

  async waitForApprovalResolution() {
    this.approval = {
      ...this.approval,
      status: "APPROVED",
      responseNote: "Approved during host workflow smoke.",
    };
    this.emit("NODE_APPROVAL_RESOLVED", {
      approvalId: this.approval.id,
      taskId: this.approval.taskId,
      status: this.approval.status,
    });

    return {
      approval: this.approval,
      timedOut: false,
      matchedEvent: "NODE_APPROVAL_RESOLVED",
      event: {
        approvalId: this.approval.id,
        taskId: this.approval.taskId,
        status: this.approval.status,
      },
    };
  }

  async submitDeliveryForWorkerRun() {
    this.run = {
      ...this.run,
      status: "RUNNING",
      percent: 100,
      currentStep: "Delivery submitted, waiting for requester review",
      summary: "Delivery submitted successfully and is now under requester review.",
    };

    return {
      txHash: "0xdeliverysmoke",
      deliveryId: "delivery-smoke-001",
      delivery: {
        id: "delivery-smoke-001",
        taskId: this.task.id,
      },
      run: this.run,
    };
  }

  async waitForRequesterReviewOutcome() {
    this.task.status = "ACCEPTED";
    this.task.workflow.deliveryStage = "ACCEPTED";
    this.emit("TASK_ACCEPTED", {
      taskId: this.task.id,
      status: this.task.status,
    });

    return {
      timedOut: false,
      matchedEvent: "TASK_ACCEPTED",
      task: this.task,
      event: {
        taskId: this.task.id,
        status: this.task.status,
      },
    };
  }

  async syncWorkerRunWithRequesterReview(params: { outcome: "TASK_ACCEPTED" | "REVISION_REQUESTED" | "TASK_SETTLED" }) {
    this.run = {
      ...this.run,
      status: params.outcome === "REVISION_REQUESTED" ? "RUNNING" : "SUCCEEDED",
      currentStep:
        params.outcome === "TASK_ACCEPTED"
          ? "Requester accepted the delivery"
          : params.outcome === "TASK_SETTLED"
            ? "Task settled after requester review"
            : "Requester requested revision work",
      summary:
        params.outcome === "TASK_ACCEPTED"
          ? "Delivery accepted by the requester."
          : params.outcome === "TASK_SETTLED"
            ? "Task settled after requester review."
            : "Requester review requested another revision pass.",
    };

    return {
      outcome: params.outcome,
      run: this.run,
    };
  }

  private emit(event: string, data: Record<string, unknown>) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ type: event, data });
    }
  }
}

async function runWorkflowScenario(liveTools: BuiltLiveToolsModule) {
  const api = new FakePluginApi();
  const mockAgent = new MockWorkflowAgent();
  const runtime = liveTools.createLiveToolRuntime({
    logger: api.logger,
    agentFactory: async () => mockAgent as unknown,
  });

  liveTools.registerOpenClawLiveTools(api, runtime);

  const session = getStructuredContent<{
    run: { id: string; status: string };
    brief: { pendingApprovals: unknown[] };
  }>(
    await api.getTool("agentpact_begin_task_session").execute({
      taskId: "task-host-001",
      hostKind: "OPENCLAW",
      workerKey: "openclaw:smoke-worker",
    }),
    "session"
  );
  assert.equal(session.run.status, "RUNNING", "begin_task_session should start a RUNNING worker run");
  assert.equal(session.brief.pendingApprovals.length, 0, "begin_task_session should begin without pending approvals");

  const resumed = getStructuredContent<{
    reusedExistingRun: boolean;
    run: { id: string };
  }>(
    await api.getTool("agentpact_resume_task_session").execute({
      taskId: "task-host-001",
      hostKind: "OPENCLAW",
      workerKey: "openclaw:smoke-worker",
    }),
    "session"
  );
  assert.equal(resumed.reusedExistingRun, true, "resume_task_session should reuse the active run");
  assert.equal(resumed.run.id, session.run.id, "resume_task_session should keep the same run id");

  const gated = getStructuredContent<{
    run: { status: string };
    approval: { id: string; status: string };
  }>(
    await api.getTool("agentpact_gate_worker_run_for_approval").execute({
      runId: session.run.id,
      taskId: "task-host-001",
      kind: "STRATEGY_DECISION",
      title: "Need owner approval before publish step",
      summary: "Publish step touches an external endpoint.",
    }),
    "result"
  );
  assert.equal(gated.run.status, "WAITING_APPROVAL", "gate_worker_run_for_approval should pause the run");
  assert.equal(gated.approval.status, "PENDING", "approval should start pending");

  const approvalWait = getStructuredContent<{
    timedOut: boolean;
    approval: { status: string };
  }>(
    await api.getTool("agentpact_wait_for_approval_resolution").execute({
      approvalId: gated.approval.id,
      taskId: "task-host-001",
      timeoutMs: 5000,
    }),
    "result"
  );
  assert.equal(approvalWait.timedOut, false, "approval should resolve during workflow smoke");
  assert.equal(approvalWait.approval.status, "APPROVED", "approval should resolve as approved");

  const delivered = getStructuredContent<{
    deliveryId: string;
    run: { currentStep: string };
  }>(
    await api.getTool("agentpact_submit_delivery_for_worker_run").execute({
      runId: session.run.id,
      taskId: "task-host-001",
      escrowId: "42",
      deliveryHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      content: "Workflow smoke delivery payload",
    }),
    "result"
  );
  assert.equal(delivered.deliveryId, "delivery-smoke-001", "delivery should be attached to the worker run flow");
  assert.match(delivered.run.currentStep, /waiting for requester review/i, "delivery should move the run into requester review waiting state");

  const review = getStructuredContent<{
    timedOut: boolean;
    matchedEvent: string;
    task: { status: string };
  }>(
    await api.getTool("agentpact_wait_for_requester_review_outcome").execute({
      taskId: "task-host-001",
      timeoutMs: 5000,
    }),
    "result"
  );
  assert.equal(review.timedOut, false, "requester review should arrive during workflow smoke");
  assert.equal(review.matchedEvent, "TASK_ACCEPTED", "workflow smoke should end with TASK_ACCEPTED");
  assert.equal(review.task.status, "ACCEPTED", "task should be accepted before run sync");

  const synced = getStructuredContent<{
    outcome: string;
    run: { status: string; currentStep: string };
  }>(
    await api.getTool("agentpact_sync_worker_run_with_requester_review").execute({
      runId: session.run.id,
      outcome: "TASK_ACCEPTED",
    }),
    "result"
  );
  assert.equal(synced.outcome, "TASK_ACCEPTED", "worker sync should preserve requester review outcome");
  assert.equal(synced.run.status, "SUCCEEDED", "accepted requester review should close the run as succeeded");
  assert.match(synced.run.currentStep, /Requester accepted/i, "final run step should reflect requester acceptance");

  return {
    finalRunStatus: synced.run.status,
    approvalStatus: approvalWait.approval.status,
    requesterOutcome: review.matchedEvent,
  };
}

async function main() {
  const register = await importBuiltPlugin();
  const liveTools = await importBuiltLiveTools();
  const { getSharedLiveToolNames } = liveTools;
  const liveToolNames = getSharedLiveToolNames();

  const active = await runActiveRegistrationScenario(register, liveToolNames);
  const conflict = await runMcpConflictScenario(register);
  const workflow = await runWorkflowScenario(liveTools);

  console.log("[openclaw-smoke] passed");
  console.log(
    `[openclaw-smoke] active registration: ${active.registeredToolCount} tools ` +
      `(${active.liveToolCount} live + ${active.helperToolCount} helpers)`
  );
  console.log(`[openclaw-smoke] MCP conflict deferral still keeps ${conflict.registeredToolCount} helper tools available`);
  console.log(
    `[openclaw-smoke] workflow orchestration: approval=${workflow.approvalStatus} ` +
      `review=${workflow.requesterOutcome} finalRun=${workflow.finalRunStatus}`
  );
}

main().catch((error) => {
  console.error("[openclaw-smoke] failed:", error);
  process.exit(1);
});
