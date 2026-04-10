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
  const liveToolsPath = new URL("../../live-tools/dist/index.js", import.meta.url).href;
  const module = await import(liveToolsPath) as {
    getSharedLiveToolNames: () => string[];
  };
  return module;
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

async function main() {
  const register = await importBuiltPlugin();
  const { getSharedLiveToolNames } = await importBuiltLiveTools();
  const liveToolNames = getSharedLiveToolNames();

  const active = await runActiveRegistrationScenario(register, liveToolNames);
  const conflict = await runMcpConflictScenario(register);

  console.log("[openclaw-smoke] passed");
  console.log(
    `[openclaw-smoke] active registration: ${active.registeredToolCount} tools ` +
      `(${active.liveToolCount} live + ${active.helperToolCount} helpers)`
  );
  console.log(`[openclaw-smoke] MCP conflict deferral still keeps ${conflict.registeredToolCount} helper tools available`);
}

main().catch((error) => {
  console.error("[openclaw-smoke] failed:", error);
  process.exit(1);
});
