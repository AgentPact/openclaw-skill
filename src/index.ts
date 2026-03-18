import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const PLUGIN_ID = "agentpact";
const DEFAULT_MCP_SERVER_NAME = "agentpact";
const DEFAULT_STATE = {
  lastEventPoll: 0,
  lastTaskDiscovery: 0,
  lastDeadlineCheck: 0,
  lastChatCheck: 0,
  lastEventCursor: "",
  activeTasks: [] as string[],
  pendingConfirmations: [] as string[],
  recentTaskIds: [] as string[],
  processedRevisionKeys: [] as string[],
  processedEventKeys: [] as string[],
  sentMessageKeys: [] as string[],
  bidTaskIds: [] as string[],
};
const MAX_TRACKED_KEYS = 200;

type PluginApi = any;
type JsonRecord = Record<string, any>;

type TaskWorkspaceInput = {
  taskId: string;
  escrowId?: string;
  category?: string;
  difficulty?: string;
  reward?: string | number;
  status?: string;
  summary?: string;
  publicMaterials?: string[];
  confidentialMaterials?: string[];
};

type TriageInput = {
  taskId?: string;
  title?: string;
  summary?: string;
  category?: string;
  difficulty?: string;
  reward?: string | number;
  publicMaterials?: string[];
  activeTaskCount?: number;
  capabilityTags?: string[];
  requiredTags?: string[];
  requiresHumanReview?: boolean;
};

type RevisionInput = {
  taskId: string;
  revision?: number;
  originalScope?: string[];
  revisionItems?: string[];
  requesterComments?: string[];
};

type DeliveryInput = {
  taskId: string;
  escrowId?: string;
  category?: string;
  revision?: number;
  artifacts?: Array<{ name?: string; path?: string; type?: string }>;
  checks?: string[];
  notes?: string;
  acceptanceCriteria?: string[];
};

type ConfirmationReviewInput = {
  taskId: string;
  publicSummary?: string;
  confidentialSummary?: string;
  publicMaterials?: string[];
  confidentialMaterials?: string[];
  difficulty?: string;
  reward?: string | number;
};

type ProposalInput = {
  taskId: string;
  title?: string;
  summary?: string;
  category?: string;
  difficulty?: string;
  reward?: string | number;
  deliverables?: string[];
  risks?: string[];
  assumptions?: string[];
};

function textResult(text: string) {
  return {
    content: [{ type: "text", text }],
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function getPluginConfig(api: PluginApi): JsonRecord {
  return api?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
}

function getMcpServerName(api: PluginApi) {
  const config = getPluginConfig(api);
  return typeof config.mcpServerName === "string" && config.mcpServerName.trim()
    ? config.mcpServerName.trim()
    : DEFAULT_MCP_SERVER_NAME;
}

function getOpenClawConfigPath() {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function getStatePath() {
  return path.join(os.homedir(), ".openclaw", "workspace", "memory", "agentpact-state.json");
}

function getTasksRoot() {
  return path.join(os.homedir(), ".openclaw", "workspace", "agentpact", "tasks");
}

function getTaskRoot(taskId: string) {
  return path.join(getTasksRoot(), taskId.trim());
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(values: unknown) {
  if (!Array.isArray(values)) return [] as string[];
  return uniqueTrimmed(values);
}

function uniqueTrimmed(values: unknown[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function keepRecent(values: string[], max = MAX_TRACKED_KEYS) {
  return values.slice(Math.max(0, values.length - max));
}

function appendReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(target: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(target: string, value: unknown) {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

async function loadOpenClawConfig() {
  const configPath = getOpenClawConfigPath();
  const exists = await pathExists(configPath);
  if (!exists) {
    return { configPath, exists: false, config: {} as JsonRecord };
  }

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const sanitized = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const parsed = sanitized.trim() ? JSON.parse(sanitized) : {};
    return { configPath, exists: true, config: parsed as JsonRecord };
  } catch {
    return { configPath, exists: true, config: {} as JsonRecord };
  }
}

async function loadState() {
  const statePath = getStatePath();
  const current = await readJsonFile<JsonRecord>(statePath);
  const merged = {
    ...DEFAULT_STATE,
    ...(current ?? {}),
  };
  merged.activeTasks = uniqueTrimmed(Array.isArray(merged.activeTasks) ? merged.activeTasks : []);
  merged.pendingConfirmations = uniqueTrimmed(Array.isArray(merged.pendingConfirmations) ? merged.pendingConfirmations : []);
  merged.recentTaskIds = keepRecent(uniqueTrimmed(Array.isArray(merged.recentTaskIds) ? merged.recentTaskIds : []));
  merged.processedRevisionKeys = keepRecent(uniqueTrimmed(Array.isArray(merged.processedRevisionKeys) ? merged.processedRevisionKeys : []));
  merged.processedEventKeys = keepRecent(uniqueTrimmed(Array.isArray(merged.processedEventKeys) ? merged.processedEventKeys : []));
  merged.sentMessageKeys = keepRecent(uniqueTrimmed(Array.isArray(merged.sentMessageKeys) ? merged.sentMessageKeys : []));
  merged.bidTaskIds = keepRecent(uniqueTrimmed(Array.isArray(merged.bidTaskIds) ? merged.bidTaskIds : []));
  return { statePath, state: merged };
}

async function saveState(state: JsonRecord) {
  const statePath = getStatePath();
  await writeJsonFile(statePath, state);
  return statePath;
}

async function ensureWorkspace(task: TaskWorkspaceInput) {
  const taskId = task.taskId.trim();
  if (!taskId) throw new Error("taskId is required");

  const taskRoot = getTaskRoot(taskId);
  const proposalDir = path.join(taskRoot, "proposal");
  const workDir = path.join(taskRoot, "work");
  const deliveryDir = path.join(taskRoot, "delivery");
  const revisionsDir = path.join(taskRoot, "revisions");
  const publicMaterialsDir = path.join(taskRoot, "public-materials");
  const confidentialMaterialsDir = path.join(taskRoot, "confidential-materials");

  await Promise.all([
    ensureDir(taskRoot),
    ensureDir(proposalDir),
    ensureDir(workDir),
    ensureDir(deliveryDir),
    ensureDir(revisionsDir),
    ensureDir(publicMaterialsDir),
    ensureDir(confidentialMaterialsDir),
  ]);

  const taskJsonPath = path.join(taskRoot, "task.json");
  const summaryPath = path.join(taskRoot, "summary.md");
  const notesPath = path.join(deliveryDir, "notes.md");
  const manifestPath = path.join(deliveryDir, "manifest.json");
  const proposalPath = path.join(proposalDir, "proposal.md");

  const taskJson = {
    taskId,
    escrowId: task.escrowId ?? "",
    category: task.category ?? "",
    difficulty: task.difficulty ?? "",
    reward: task.reward ?? "",
    status: task.status ?? "",
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(taskJsonPath, taskJson);

  const summary = [
    `# Task ${taskId}`,
    "",
    task.summary ? task.summary : "No summary yet.",
    "",
    "## Metadata",
    `- Escrow ID: ${task.escrowId ?? ""}`,
    `- Category: ${task.category ?? ""}`,
    `- Difficulty: ${task.difficulty ?? ""}`,
    `- Reward: ${task.reward ?? ""}`,
    `- Status: ${task.status ?? ""}`,
    "",
    "## Public materials",
    ...(task.publicMaterials?.length ? task.publicMaterials.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Confidential materials",
    ...(task.confidentialMaterials?.length ? task.confidentialMaterials.map((item) => `- ${item}`) : ["- none"]),
    "",
  ].join("\n");
  await fs.writeFile(summaryPath, summary, "utf8");

  if (!(await pathExists(notesPath))) {
    await fs.writeFile(notesPath, "# Delivery Notes\n\n", "utf8");
  }
  if (!(await pathExists(proposalPath))) {
    await fs.writeFile(proposalPath, "# Proposal\n\n", "utf8");
  }
  if (!(await pathExists(manifestPath))) {
    await writeJsonFile(manifestPath, {
      taskId,
      escrowId: task.escrowId ?? "",
      category: task.category ?? "",
      revision: 0,
      artifacts: [],
      checks: [],
      notes: "",
      generatedAt: new Date().toISOString(),
    });
  }

  const { state } = await loadState();
  state.recentTaskIds = keepRecent(uniqueTrimmed([...state.recentTaskIds, taskId]));
  if (task.status && ["working", "confirmed", "in_revision", "active"].includes(String(task.status).toLowerCase())) {
    state.activeTasks = uniqueTrimmed([...state.activeTasks, taskId]);
  }
  if (task.status && ["pending_confirmation", "confirmation_pending"].includes(String(task.status).toLowerCase())) {
    state.pendingConfirmations = uniqueTrimmed([...state.pendingConfirmations, taskId]);
  }
  await saveState(state);

  return {
    taskRoot,
    taskJsonPath,
    summaryPath,
    proposalPath,
    manifestPath,
    notesPath,
  };
}

async function writeMarkdown(target: string, lines: string[]) {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

function stateSummaryLines(state: JsonRecord) {
  return [
    `activeTasks: ${state.activeTasks.length}`,
    `pendingConfirmations: ${state.pendingConfirmations.length}`,
    `recentTaskIds: ${state.recentTaskIds.length}`,
    `processedRevisionKeys: ${state.processedRevisionKeys.length}`,
    `processedEventKeys: ${state.processedEventKeys.length}`,
    `sentMessageKeys: ${state.sentMessageKeys.length}`,
    `bidTaskIds: ${state.bidTaskIds.length}`,
  ];
}

function analyzeTriage(input: TriageInput) {
  const reasons: string[] = [];
  const category = normalizeText(input.category).toLowerCase();
  const difficulty = normalizeText(input.difficulty).toLowerCase();
  const summary = normalizeText(input.summary);
  const title = normalizeText(input.title);
  const publicMaterials = normalizeStringArray(input.publicMaterials);
  const requiredTags = normalizeStringArray(input.requiredTags).map((item) => item.toLowerCase());
  const capabilityTags = normalizeStringArray(input.capabilityTags).map((item) => item.toLowerCase());
  const activeTaskCount = typeof input.activeTaskCount === "number" ? input.activeTaskCount : 0;

  let numericReward = 0;
  if (typeof input.reward === "number") numericReward = input.reward;
  if (typeof input.reward === "string") {
    const match = input.reward.match(/\d+(\.\d+)?/);
    numericReward = match ? Number(match[0]) : 0;
  }

  let riskLevel: "low" | "medium" | "high" = "low";
  let shouldBid = true;
  let needsHumanReview = Boolean(input.requiresHumanReview);

  if (!summary && !title) {
    shouldBid = false;
    riskLevel = "high";
    appendReason(reasons, "Task has almost no usable description.");
  }

  if (difficulty === "complex" || difficulty === "expert") {
    needsHumanReview = true;
    riskLevel = "high";
    appendReason(reasons, `Difficulty is ${difficulty}, so a human gate is recommended.`);
  }

  if (activeTaskCount >= 3) {
    needsHumanReview = true;
    riskLevel = riskLevel === "high" ? "high" : "medium";
    appendReason(reasons, `Current active task count is ${activeTaskCount}, so capacity is tighter.`);
  }

  if (publicMaterials.length === 0) {
    riskLevel = riskLevel === "high" ? "high" : "medium";
    appendReason(reasons, "No public materials were provided yet.");
  }

  if (numericReward > 0 && numericReward < 20) {
    riskLevel = riskLevel === "high" ? "high" : "medium";
    appendReason(reasons, `Reward looks low (${numericReward}).`);
  }

  if (requiredTags.length > 0) {
    const matched = requiredTags.filter((tag) => capabilityTags.includes(tag));
    if (matched.length === 0 && capabilityTags.length > 0) {
      shouldBid = false;
      riskLevel = "high";
      appendReason(reasons, "Required tags do not match declared capability tags.");
    } else if (matched.length < requiredTags.length) {
      needsHumanReview = true;
      riskLevel = riskLevel === "high" ? "high" : "medium";
      appendReason(reasons, "Capability tags only partially match required tags.");
    }
  }

  if (!["software", "writing", "research", "data", "visual", "video", "audio", "general", ""].includes(category)) {
    needsHumanReview = true;
    riskLevel = riskLevel === "high" ? "high" : "medium";
    appendReason(reasons, `Category '${category}' is unfamiliar to the current heuristics.`);
  }

  if (summary.length > 0 && summary.length < 40) {
    riskLevel = riskLevel === "high" ? "high" : "medium";
    appendReason(reasons, "Summary is very short; scope may be too vague.");
  }

  const recommendation = !shouldBid
    ? "skip"
    : needsHumanReview
      ? "review"
      : "bid";

  return {
    recommendation,
    shouldBid,
    needsHumanReview,
    riskLevel,
    reasons,
    category: category || "unknown",
    difficulty: difficulty || "unknown",
    reward: input.reward ?? "",
  };
}

function classifyRevisionItems(originalScope: string[], revisionItems: string[]) {
  const valid: string[] = [];
  const ambiguous: string[] = [];
  const scopeRisk: string[] = [];

  for (const item of revisionItems) {
    const lower = item.toLowerCase();
    const matched = originalScope.some((scope) => scope && lower.includes(scope.toLowerCase()));
    if (matched) {
      valid.push(item);
      continue;
    }

    if (/(new|additional|extra|expand|broader|more feature|another)/i.test(item)) {
      scopeRisk.push(item);
      continue;
    }

    ambiguous.push(item);
  }

  return { valid, ambiguous, scopeRisk };
}

function buildDeliveryChecks(input: DeliveryInput) {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria);
  const notes = normalizeText(input.notes);

  checks.push({
    name: "artifacts_present",
    passed: artifacts.length > 0,
    detail: artifacts.length > 0 ? `${artifacts.length} artifact(s) listed.` : "No artifacts were listed.",
  });
  checks.push({
    name: "notes_present",
    passed: notes.length > 0,
    detail: notes.length > 0 ? "Delivery notes provided." : "Delivery notes are missing.",
  });
  checks.push({
    name: "acceptance_criteria_recorded",
    passed: acceptanceCriteria.length > 0,
    detail: acceptanceCriteria.length > 0 ? `${acceptanceCriteria.length} acceptance criteria recorded.` : "No acceptance criteria recorded.",
  });

  const artifactNames = artifacts.map((artifact) => `${artifact.name ?? ""} ${artifact.path ?? ""}`).join(" ").toLowerCase();
  const notesLower = notes.toLowerCase();
  const secretRegex = /(agent_pk|private_key|seed phrase|mnemonic|jwt|token|0x[a-f0-9]{32,})/i;
  const suspicious = secretRegex.test(`${artifactNames} ${notesLower}`);
  checks.push({
    name: "secret_scan_basic",
    passed: !suspicious,
    detail: suspicious ? "Potential secret-like content detected in names or notes." : "No obvious secret-like patterns detected in names or notes.",
  });

  return checks;
}

function analyzeConfirmationDelta(input: ConfirmationReviewInput) {
  const publicSummary = normalizeText(input.publicSummary);
  const confidentialSummary = normalizeText(input.confidentialSummary);
  const publicMaterials = normalizeStringArray(input.publicMaterials);
  const confidentialMaterials = normalizeStringArray(input.confidentialMaterials);
  const difficulty = normalizeText(input.difficulty).toLowerCase();
  const reasons: string[] = [];

  let riskLevel: "low" | "medium" | "high" = "low";
  let recommendation: "confirm" | "clarify" | "review" | "decline" = "confirm";

  const summaryDelta = confidentialSummary && publicSummary && confidentialSummary !== publicSummary;
  const confidentialOnly = confidentialMaterials.filter((item) => !publicMaterials.includes(item));

  if (!confidentialSummary && confidentialMaterials.length === 0) {
    riskLevel = "medium";
    recommendation = "clarify";
    appendReason(reasons, "Confidential detail payload is still thin; review may be incomplete.");
  }

  if (summaryDelta) {
    riskLevel = "medium";
    appendReason(reasons, "Confidential summary differs from the public summary.");
  }

  if (confidentialOnly.length >= 3) {
    riskLevel = "high";
    recommendation = "review";
    appendReason(reasons, "Several confidential-only materials were introduced after the public phase.");
  }

  if (/(new|additional|extra|migration|integration|deployment|production|full stack|admin panel)/i.test(confidentialSummary)) {
    riskLevel = "high";
    recommendation = "review";
    appendReason(reasons, "Confidential summary suggests additional scope or complexity.");
  }

  if (difficulty === "complex" || difficulty === "expert") {
    riskLevel = "high";
    recommendation = "review";
    appendReason(reasons, `Difficulty is ${difficulty}, so confirmation should usually pass a human gate.`);
  }

  if (/(api key|credential|secret|private key|seed phrase)/i.test(confidentialSummary)) {
    riskLevel = "high";
    recommendation = "decline";
    appendReason(reasons, "Confidential summary appears to request sensitive credentials or secrets.");
  }

  return {
    recommendation,
    riskLevel,
    reasons,
    publicMaterialsCount: publicMaterials.length,
    confidentialMaterialsCount: confidentialMaterials.length,
    confidentialOnlyMaterials: confidentialOnly,
  };
}

function buildProposalMarkdown(input: ProposalInput) {
  const category = normalizeText(input.category).toLowerCase() || "general";
  const title = normalizeText(input.title) || input.taskId;
  const summary = normalizeText(input.summary) || "No summary provided yet.";
  const deliverables = normalizeStringArray(input.deliverables);
  const risks = normalizeStringArray(input.risks);
  const assumptions = normalizeStringArray(input.assumptions);

  const intro = category === "software"
    ? "## Approach\n- I will break the work into implementation, validation, and delivery steps."
    : category === "writing"
      ? "## Approach\n- I will align the output to the requested audience, tone, and format."
      : category === "research"
        ? "## Approach\n- I will structure the work around source collection, synthesis, and a clear final output."
        : "## Approach\n- I will turn the task into a concrete execution plan and deliverable set.";

  return [
    `# Proposal for ${title}`,
    "",
    "## Task understanding",
    `- Category: ${category}`,
    `- Difficulty: ${normalizeText(input.difficulty) || "unspecified"}`,
    `- Reward: ${input.reward ?? ""}`,
    `- Summary: ${summary}`,
    "",
    intro,
    "",
    "## Deliverables",
    ...(deliverables.length ? deliverables.map((item) => `- ${item}`) : ["- Deliverables will follow the confirmed task requirements."]),
    "",
    "## Risks and assumptions",
    ...(risks.length ? risks.map((item) => `- Risk: ${item}`) : ["- Risk: scope or dependency changes after confidential review may require clarification."]),
    ...(assumptions.length ? assumptions.map((item) => `- Assumption: ${item}`) : ["- Assumption: provided materials are sufficient to begin and finish the task."]),
    "",
    "## Delivery intent",
    "- I will keep the work aligned to the stated criteria, communicate early when blocked, and submit with clear delivery notes.",
    "",
  ].join("\n");
}

function buildHeartbeatPlan(state: JsonRecord) {
  if ((state.pendingConfirmations?.length ?? 0) > 0) {
    return {
      priority: "pending_confirmations",
      suggestedActions: [
        "review pending confirmations first",
        "run confirmation delta review before confirm/decline",
      ],
    };
  }
  if ((state.activeTasks?.length ?? 0) > 0) {
    return {
      priority: "active_tasks",
      suggestedActions: [
        "check active task deadlines",
        "check for revisions or chat that need action",
      ],
    };
  }
  return {
    priority: "discovery",
    suggestedActions: [
      "poll events",
      "discover new tasks if capacity allows",
      "triage before bidding",
    ],
  };
}

export default function register(api: PluginApi) {
  api?.logger?.info?.("AgentPact OpenClaw integration loaded (MCP-first mode)");

  api.registerTool({
    name: "agentpact_openclaw_help",
    description: "Explain how the AgentPact OpenClaw integration works in MCP-first mode and what to configure.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    optional: true,
    execute: async () => {
      const mcpServerName = getMcpServerName(api);
      return textResult(
        [
          "AgentPact OpenClaw integration is running in MCP-first mode.",
          "",
          `Expected MCP server name: ${mcpServerName}`,
          "",
          "What this plugin now provides:",
          "- bundled AgentPact skill files",
          "- bundled heartbeat guidance",
          "- OpenClaw-specific docs/templates/examples",
          "- local task workspace helpers",
          "- local state / idempotency helpers",
          "- triage / revision / delivery preparation helpers",
          "",
          "What provides the actual AgentPact tools:",
          "- @agentpactai/mcp-server",
        ].join("\n")
      );
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_status",
    description: "Check MCP-related OpenClaw configuration, local state file presence, and task workspace root.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    optional: true,
    execute: async () => {
      const mcpServerName = getMcpServerName(api);
      const { configPath, exists, config } = await loadOpenClawConfig();
      const mcpServers = config?.mcpServers ?? {};
      const mcpEntry = mcpServers?.[mcpServerName];
      const statePath = getStatePath();
      const taskRoot = getTasksRoot();
      const stateExists = await pathExists(statePath);
      const taskRootExists = await pathExists(taskRoot);

      return jsonResult({
        mode: "mcp-first",
        openclawConfigPath: configPath,
        openclawConfigExists: exists,
        expectedMcpServerName: mcpServerName,
        mcpServerConfigured: Boolean(mcpEntry),
        mcpServerConfig: mcpEntry ?? null,
        statePath,
        stateExists,
        tasksRoot: taskRoot,
        tasksRootExists: taskRootExists,
      });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_state_get",
    description: "Read the local AgentPact OpenClaw state file used for heartbeat/idempotency tracking.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ensureExists: { type: "boolean", default: true },
      },
    },
    optional: true,
    execute: async (params: JsonRecord = {}) => {
      const { statePath, state } = await loadState();
      if (params.ensureExists !== false) {
        await saveState(state);
      }
      return jsonResult({ statePath, state, summary: stateSummaryLines(state) });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_state_update",
    description: "Update local AgentPact OpenClaw state fields such as active tasks, pending confirmations, or recent ids.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        set: { type: "object" },
        addActiveTaskIds: { type: "array", items: { type: "string" } },
        removeActiveTaskIds: { type: "array", items: { type: "string" } },
        addPendingConfirmationIds: { type: "array", items: { type: "string" } },
        removePendingConfirmationIds: { type: "array", items: { type: "string" } },
        addRecentTaskIds: { type: "array", items: { type: "string" } },
      },
    },
    optional: true,
    execute: async (params: JsonRecord = {}) => {
      const { state } = await loadState();
      if (params.set && typeof params.set === "object") {
        Object.assign(state, params.set);
      }
      if (Array.isArray(params.addActiveTaskIds)) {
        state.activeTasks = uniqueTrimmed([...state.activeTasks, ...params.addActiveTaskIds]);
      }
      if (Array.isArray(params.removeActiveTaskIds)) {
        const remove = new Set(uniqueTrimmed(params.removeActiveTaskIds));
        state.activeTasks = state.activeTasks.filter((item: string) => !remove.has(item));
      }
      if (Array.isArray(params.addPendingConfirmationIds)) {
        state.pendingConfirmations = uniqueTrimmed([...state.pendingConfirmations, ...params.addPendingConfirmationIds]);
      }
      if (Array.isArray(params.removePendingConfirmationIds)) {
        const remove = new Set(uniqueTrimmed(params.removePendingConfirmationIds));
        state.pendingConfirmations = state.pendingConfirmations.filter((item: string) => !remove.has(item));
      }
      if (Array.isArray(params.addRecentTaskIds)) {
        state.recentTaskIds = keepRecent(uniqueTrimmed([...state.recentTaskIds, ...params.addRecentTaskIds]));
      }
      const statePath = await saveState(state);
      return jsonResult({ statePath, state, summary: stateSummaryLines(state) });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_workspace_init",
    description: "Create or update a local task workspace for an AgentPact task and seed basic task files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        escrowId: { type: "string" },
        category: { type: "string" },
        difficulty: { type: "string" },
        reward: { type: ["string", "number"] },
        status: { type: "string" },
        summary: { type: "string" },
        publicMaterials: { type: "array", items: { type: "string" } },
        confidentialMaterials: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
    optional: true,
    execute: async (params: TaskWorkspaceInput) => {
      const result = await ensureWorkspace(params);
      return jsonResult(result);
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_mark_processed",
    description: "Record processed event/revision/message/bid keys to support idempotent semi-automated workflows.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["event", "revision", "message", "bid"],
        },
        key: { type: "string" },
      },
      required: ["kind", "key"],
    },
    optional: true,
    execute: async (params: { kind: string; key: string }) => {
      const { state } = await loadState();
      const key = params.key.trim();
      if (!key) throw new Error("key is required");

      if (params.kind === "event") {
        state.processedEventKeys = keepRecent(uniqueTrimmed([...state.processedEventKeys, key]));
      } else if (params.kind === "revision") {
        state.processedRevisionKeys = keepRecent(uniqueTrimmed([...state.processedRevisionKeys, key]));
      } else if (params.kind === "message") {
        state.sentMessageKeys = keepRecent(uniqueTrimmed([...state.sentMessageKeys, key]));
      } else if (params.kind === "bid") {
        state.bidTaskIds = keepRecent(uniqueTrimmed([...state.bidTaskIds, key]));
      }

      const statePath = await saveState(state);
      return jsonResult({ statePath, state, summary: stateSummaryLines(state) });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_triage_task",
    description: "Perform a local host-side triage pass for a task and persist the result in the task workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        category: { type: "string" },
        difficulty: { type: "string" },
        reward: { type: ["string", "number"] },
        publicMaterials: { type: "array", items: { type: "string" } },
        activeTaskCount: { type: "number" },
        capabilityTags: { type: "array", items: { type: "string" } },
        requiredTags: { type: "array", items: { type: "string" } },
        requiresHumanReview: { type: "boolean" },
      },
    },
    optional: true,
    execute: async (params: TriageInput = {}) => {
      const triage = analyzeTriage(params);
      if (params.taskId && normalizeText(params.taskId)) {
        await ensureWorkspace({
          taskId: params.taskId,
          category: params.category,
          difficulty: params.difficulty,
          reward: params.reward,
          summary: params.summary || params.title,
          publicMaterials: params.publicMaterials,
        });
        const triagePath = path.join(getTaskRoot(params.taskId), "triage.json");
        await writeJsonFile(triagePath, {
          ...triage,
          title: params.title ?? "",
          summary: params.summary ?? "",
          generatedAt: new Date().toISOString(),
        });
      }
      return jsonResult(triage);
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_prepare_revision",
    description: "Create a structured local revision analysis for a task and classify items into valid, ambiguous, or scope-risk buckets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        revision: { type: "number" },
        originalScope: { type: "array", items: { type: "string" } },
        revisionItems: { type: "array", items: { type: "string" } },
        requesterComments: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
    optional: true,
    execute: async (params: RevisionInput) => {
      const revisionNumber = typeof params.revision === "number" && params.revision > 0 ? params.revision : 1;
      await ensureWorkspace({ taskId: params.taskId, status: "in_revision" });
      const originalScope = normalizeStringArray(params.originalScope);
      const revisionItems = normalizeStringArray(params.revisionItems);
      const requesterComments = normalizeStringArray(params.requesterComments);
      const classified = classifyRevisionItems(originalScope, revisionItems);
      const recommendation = classified.scopeRisk.length > 0
        ? "clarify_scope_before_full_execution"
        : classified.ambiguous.length > 0
          ? "review_then_execute"
          : "execute_revision";

      const revisionDir = path.join(getTaskRoot(params.taskId), "revisions", `rev-${revisionNumber}`);
      await ensureDir(revisionDir);
      const analysisPath = path.join(revisionDir, "analysis.md");
      await writeMarkdown(analysisPath, [
        "# Revision Analysis",
        "",
        `- Task: ${params.taskId}`,
        `- Revision: ${revisionNumber}`,
        `- Recommendation: ${recommendation}`,
        "",
        "## Original scope",
        ...(originalScope.length ? originalScope.map((item) => `- ${item}`) : ["- none recorded"]),
        "",
        "## Revision items: valid",
        ...(classified.valid.length ? classified.valid.map((item) => `- ${item}`) : ["- none"]),
        "",
        "## Revision items: ambiguous",
        ...(classified.ambiguous.length ? classified.ambiguous.map((item) => `- ${item}`) : ["- none"]),
        "",
        "## Revision items: possible scope expansion",
        ...(classified.scopeRisk.length ? classified.scopeRisk.map((item) => `- ${item}`) : ["- none"]),
        "",
        "## Requester comments",
        ...(requesterComments.length ? requesterComments.map((item) => `- ${item}`) : ["- none"]),
        "",
      ]);

      const revisionKey = `${params.taskId}:rev:${revisionNumber}`;
      const { state } = await loadState();
      state.processedRevisionKeys = keepRecent(uniqueTrimmed([...state.processedRevisionKeys, revisionKey]));
      await saveState(state);

      return jsonResult({
        taskId: params.taskId,
        revision: revisionNumber,
        recommendation,
        classified,
        analysisPath,
      });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_prepare_delivery",
    description: "Run a local delivery preflight, update the delivery manifest, and return the checklist result.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        escrowId: { type: "string" },
        category: { type: "string" },
        revision: { type: "number" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              type: { type: "string" },
            },
          },
        },
        checks: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
    optional: true,
    execute: async (params: DeliveryInput) => {
      await ensureWorkspace({
        taskId: params.taskId,
        escrowId: params.escrowId,
        category: params.category,
        status: "working",
      });
      const taskRoot = getTaskRoot(params.taskId);
      const deliveryDir = path.join(taskRoot, "delivery");
      const manifestPath = path.join(deliveryDir, "manifest.json");
      const notesPath = path.join(deliveryDir, "notes.md");
      const preflightChecks = buildDeliveryChecks(params);
      const allPassed = preflightChecks.every((check) => check.passed);

      const manifest = {
        taskId: params.taskId,
        escrowId: params.escrowId ?? "",
        category: params.category ?? "",
        revision: typeof params.revision === "number" ? params.revision : 0,
        artifacts: Array.isArray(params.artifacts) ? params.artifacts : [],
        checks: [
          ...normalizeStringArray(params.checks),
          ...preflightChecks.map((item) => `${item.name}:${item.passed ? "pass" : "fail"}`),
        ],
        notes: params.notes ?? "",
        acceptanceCriteria: normalizeStringArray(params.acceptanceCriteria),
        preflightChecks,
        readyToSubmit: allPassed,
        generatedAt: new Date().toISOString(),
      };
      await writeJsonFile(manifestPath, manifest);
      await writeMarkdown(notesPath, [
        "# Delivery Notes",
        "",
        params.notes && params.notes.trim() ? params.notes.trim() : "No delivery notes provided yet.",
        "",
        "## Preflight",
        ...preflightChecks.map((item) => `- ${item.name}: ${item.passed ? "PASS" : "FAIL"} — ${item.detail}`),
        "",
      ]);

      return jsonResult({
        taskId: params.taskId,
        readyToSubmit: allPassed,
        preflightChecks,
        manifestPath,
        notesPath,
      });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_review_confirmation",
    description: "Compare public vs confidential task detail and write a local confirmation delta review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        publicSummary: { type: "string" },
        confidentialSummary: { type: "string" },
        publicMaterials: { type: "array", items: { type: "string" } },
        confidentialMaterials: { type: "array", items: { type: "string" } },
        difficulty: { type: "string" },
        reward: { type: ["string", "number"] }
      },
      required: ["taskId"],
    },
    optional: true,
    execute: async (params: ConfirmationReviewInput) => {
      await ensureWorkspace({
        taskId: params.taskId,
        difficulty: params.difficulty,
        reward: params.reward,
        summary: params.confidentialSummary || params.publicSummary,
        publicMaterials: params.publicMaterials,
        confidentialMaterials: params.confidentialMaterials,
        status: "confirmation_pending",
      });
      const review = analyzeConfirmationDelta(params);
      const reviewPath = path.join(getTaskRoot(params.taskId), "confirmation-review.md");
      await writeMarkdown(reviewPath, [
        "# Confirmation Review",
        "",
        `- Task: ${params.taskId}`,
        `- Recommendation: ${review.recommendation}`,
        `- Risk level: ${review.riskLevel}`,
        "",
        "## Reasons",
        ...(review.reasons.length ? review.reasons.map((item) => `- ${item}`) : ["- no major deltas detected"]),
        "",
        "## Public summary",
        normalizeText(params.publicSummary) || "(none)",
        "",
        "## Confidential summary",
        normalizeText(params.confidentialSummary) || "(none)",
        "",
        "## Confidential-only materials",
        ...(review.confidentialOnlyMaterials.length ? review.confidentialOnlyMaterials.map((item) => `- ${item}`) : ["- none"]),
        "",
      ]);
      const { state } = await loadState();
      state.pendingConfirmations = uniqueTrimmed([...state.pendingConfirmations, params.taskId]);
      await saveState(state);
      return jsonResult({ ...review, reviewPath });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_prepare_proposal",
    description: "Generate or refresh a local proposal draft for a task inside the task workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        category: { type: "string" },
        difficulty: { type: "string" },
        reward: { type: ["string", "number"] },
        deliverables: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: { type: "string" } }
      },
      required: ["taskId"],
    },
    optional: true,
    execute: async (params: ProposalInput) => {
      const workspace = await ensureWorkspace({
        taskId: params.taskId,
        category: params.category,
        difficulty: params.difficulty,
        reward: params.reward,
        summary: params.summary || params.title,
      });
      const proposal = buildProposalMarkdown(params);
      await fs.writeFile(workspace.proposalPath, proposal, "utf8");
      return jsonResult({ proposalPath: workspace.proposalPath, taskId: params.taskId });
    },
  });

  api.registerTool({
    name: "agentpact_openclaw_heartbeat_plan",
    description: "Return a minimal next-step plan for the current AgentPact heartbeat based on local state.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    optional: true,
    execute: async () => {
      const { statePath, state } = await loadState();
      return jsonResult({ statePath, plan: buildHeartbeatPlan(state), summary: stateSummaryLines(state) });
    },
  });
}
