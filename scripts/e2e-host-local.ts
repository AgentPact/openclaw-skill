import * as assert from "node:assert/strict";
import * as dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentPactAgent, AgentPactClient } from "@agentpactai/runtime";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const repoRoot = path.resolve(process.cwd(), "..");

dotenv.config({ path: path.join(repoRoot, "platform", ".env") });
dotenv.config({ path: path.join(repoRoot, ".env"), override: false });

type RegisteredTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  optional?: boolean;
  execute: (params?: Record<string, unknown>) => Promise<unknown>;
};

type PluginRegister = (api: {
  registerTool: (tool: RegisteredTool) => void;
  hasRegisteredTool?: (name: string) => boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
}) => void;

type TaskRecord = {
  id: string;
  escrowId: string | null;
  status: string;
  providerId?: string | null;
};

type WizardDraftResponse = {
  task: TaskRecord & {
    taskHash?: string | null;
    confirmation?: { confirmedHash?: string | null } | null;
  };
};

type AuthMeResponse = {
  user: {
    id: string;
  };
};

const E2E_PORT = Number(process.env.E2E_PLATFORM_PORT || "0");
const HOST = "127.0.0.1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const MIN_PROVIDER_BALANCE = parseEther("0.005");
const PROVIDER_TOP_UP = parseEther("0.02");

class FakePluginApi {
  readonly tools = new Map<string, RegisteredTool>();
  readonly logs: string[] = [];

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

  hasRegisteredTool = (name: string) => this.tools.has(name);

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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizePrivateKey(value: string): `0x${string}` {
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function getChain() {
  const chainId = Number(process.env.CHAIN_ID || "84532");
  return chainId === 8453 ? base : baseSepolia;
}

function getChainConfig() {
  return {
    chainId: Number(process.env.CHAIN_ID || "84532"),
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    escrowAddress: requiredEnv("ESCROW_ADDRESS") as `0x${string}`,
    tipJarAddress: (process.env.TIPJAR_ADDRESS || ZERO_ADDRESS) as `0x${string}`,
    usdcAddress: (process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
    explorerUrl:
      Number(process.env.CHAIN_ID || "84532") === 8453
        ? "https://basescan.org"
        : "https://sepolia.basescan.org",
  };
}

async function api<T>(
  baseUrl: string,
  targetPath: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = "GET", token, body, headers = {} } = options;
  const response = await fetch(`${baseUrl}${targetPath}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} on ${targetPath}: ${text}`);
  }

  return (await response.json()) as T;
}

async function siweLogin(
  baseUrl: string,
  walletClient: ReturnType<typeof createWalletClient>,
  address: `0x${string}`
): Promise<string> {
  const nonceResponse = await fetch(`${baseUrl}/api/auth/nonce?address=${address}`);
  if (!nonceResponse.ok) {
    throw new Error(`Failed to get nonce for ${address}: ${nonceResponse.status}`);
  }
  const { nonce } = (await nonceResponse.json()) as { nonce: string };

  const domain = new URL(baseUrl).host;
  const issuedAt = new Date().toISOString();
  const message = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to AgentPact",
    "",
    `URI: ${baseUrl}`,
    "Version: 1",
    `Chain ID: ${walletClient.chain?.id ?? 84532}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");

  const signature = await walletClient.signMessage({
    account: address,
    message,
  });
  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });

  if (!verifyResponse.ok) {
    throw new Error(`Failed to verify SIWE signature for ${address}: ${verifyResponse.status}`);
  }

  const { token } = (await verifyResponse.json()) as { token: string };
  return token;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 90000,
  intervalMs = 1500
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out while waiting for ${label}`);
}

function getStructuredContent<T>(result: unknown, key: string) {
  const structured = (result as { structuredContent?: Record<string, unknown> })?.structuredContent;
  assert.ok(structured && typeof structured === "object", "tool result did not include structured content");
  const value = structured[key];
  assert.ok(value !== undefined, `tool result did not include structured content key: ${key}`);
  return value as T;
}

async function importBuiltPlugin(): Promise<PluginRegister> {
  const pluginPath = pathToFileURL(path.resolve(process.cwd(), "dist/index.js")).href;
  const module = await import(pluginPath);
  const register = (module.default ?? module) as PluginRegister;
  assert.equal(typeof register, "function", "dist/index.js did not export a plugin register function");
  return register;
}

async function loadBuildApp(): Promise<() => Promise<{ listen: (...args: any[]) => Promise<string | { port: number }>; close: () => Promise<void> }>> {
  const appModulePath = pathToFileURL(path.join(repoRoot, "platform", "src", "app.ts")).href;
  const module = await import(appModulePath) as { buildApp: () => Promise<{ listen: (...args: any[]) => Promise<string | { port: number }>; close: () => Promise<void> }> };
  return module.buildApp;
}

async function withHostPluginEnvironment<T>(input: {
  providerPk: string;
  providerToken: string;
  platformUrl: string;
  rpcUrl: string;
}, run: (api: FakePluginApi) => Promise<T>) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpact-host-e2e-"));
  const openclawStateDir = path.join(rootDir, ".openclaw");
  const workspaceRoot = path.join(rootDir, "workspace");
  const configPath = path.join(openclawStateDir, "openclaw.json");
  const envPath = path.join(openclawStateDir, ".env");
  const previousEnv = {
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    AGENTPACT_AGENT_PK: process.env.AGENTPACT_AGENT_PK,
    AGENTPACT_JWT_TOKEN: process.env.AGENTPACT_JWT_TOKEN,
    AGENTPACT_PLATFORM: process.env.AGENTPACT_PLATFORM,
    AGENTPACT_RPC_URL: process.env.AGENTPACT_RPC_URL,
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
    await fs.writeFile(
      envPath,
      [
        `AGENTPACT_AGENT_PK=${input.providerPk}`,
        `AGENTPACT_JWT_TOKEN=${input.providerToken}`,
        `AGENTPACT_PLATFORM=${input.platformUrl}`,
        `AGENTPACT_RPC_URL=${input.rpcUrl}`,
      ].join("\n"),
      "utf8"
    );

    process.env.OPENCLAW_HOME = rootDir;
    process.env.OPENCLAW_STATE_DIR = openclawStateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.AGENTPACT_AGENT_PK = input.providerPk;
    process.env.AGENTPACT_JWT_TOKEN = input.providerToken;
    process.env.AGENTPACT_PLATFORM = input.platformUrl;
    process.env.AGENTPACT_RPC_URL = input.rpcUrl;

    const register = await importBuiltPlugin();
    const pluginApi = new FakePluginApi();
    register(pluginApi);
    return await run(pluginApi);
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

async function main() {
  const chain = getChain();
  const chainConfig = getChainConfig();
  const requesterPk = normalizePrivateKey(requiredEnv("REQUESTER_PK"));
  const providerPk = normalizePrivateKey(requiredEnv("PROVIDER_PK"));

  const requesterAccount = privateKeyToAccount(requesterPk);
  const providerAccount = privateKeyToAccount(providerPk);

  const publicClient = createPublicClient({
    chain,
    transport: http(chainConfig.rpcUrl),
  });

  const requesterWallet = createWalletClient({
    account: requesterAccount,
    chain,
    transport: http(chainConfig.rpcUrl),
  });

  const providerWallet = createWalletClient({
    account: providerAccount,
    chain,
    transport: http(chainConfig.rpcUrl),
  });

  const buildApp = await loadBuildApp();
  const app = await buildApp();
  const address = await app.listen({ port: E2E_PORT, host: HOST });
  const baseUrl = typeof address === "string" ? address.replace(/\/$/, "") : `http://${HOST}:${E2E_PORT}`;

  const requesterClient = new AgentPactClient(publicClient as never, chainConfig, requesterWallet as never);
  let providerControlAgent: AgentPactAgent | null = null;

  try {
    const providerBalance = await publicClient.getBalance({ address: providerAccount.address });
    if (providerBalance < MIN_PROVIDER_BALANCE) {
      const topUpTx = await requesterWallet.sendTransaction({
        account: requesterAccount,
        to: providerAccount.address,
        value: PROVIDER_TOP_UP,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: topUpTx });
      console.log(`[host-e2e] Topped up provider wallet: ${topUpTx}`);
    }

    const requesterToken = await siweLogin(baseUrl, requesterWallet, requesterAccount.address);
    const providerToken = await siweLogin(baseUrl, providerWallet, providerAccount.address);
    const providerAuth = await api<AuthMeResponse>(baseUrl, "/api/auth/me", {
      token: providerToken,
    });

    providerControlAgent = await AgentPactAgent.create({
      privateKey: providerPk,
      platformUrl: baseUrl,
      rpcUrl: chainConfig.rpcUrl,
      jwtToken: providerToken,
      autoClaimOnSignature: false,
    });
    await providerControlAgent.ensureProviderProfile("openclaw-agent", ["general", "software"]);
    await providerControlAgent.start();

    const seenEvents: Record<string, Record<string, unknown> | null> = {
      ASSIGNMENT_SIGNATURE: null,
      TASK_CLAIMED: null,
      TASK_ACCEPTED: null,
      NODE_APPROVAL_REQUESTED: null,
      NODE_APPROVAL_RESOLVED: null,
    };
    for (const eventName of Object.keys(seenEvents)) {
      providerControlAgent.on(eventName, (event: { data: Record<string, unknown> }) => {
        seenEvents[eventName] = event.data;
      });
    }

    console.log(`[host-e2e] Platform started at ${baseUrl}`);

    const step1 = await api<{ taskId: string }>(baseUrl, "/api/wizard/draft", {
      method: "POST",
      token: requesterToken,
      body: {
        step: 1,
        data: {
          title: `Host Adapter E2E ${Date.now()}`,
          description: "Validate AgentPact host adapter flow through the OpenClaw plugin live tools.",
          category: "SOFTWARE",
          difficulty: "MEDIUM",
        },
      },
    });
    const taskId = step1.taskId;

    await api(baseUrl, "/api/wizard/draft", {
      method: "POST",
      token: requesterToken,
      body: {
        taskId,
        step: 4,
        data: {
          deliveryDays: 7,
          deliveryDurationSeconds: 7 * 24 * 60 * 60,
          acceptanceWindowHours: 48,
          maxRevisions: 2,
          urgency: "NORMAL",
        },
      },
    });

    await api(baseUrl, "/api/wizard/draft", {
      method: "POST",
      token: requesterToken,
      body: {
        taskId,
        step: 5,
        data: {
          rewardAmount: "0.0001",
          tokenAddress: ZERO_ADDRESS,
        },
      },
    });

    const confirm = await api<{
      confirmedHash: string;
      requesterDeposit: string;
    }>(baseUrl, "/api/wizard/confirm", {
      method: "POST",
      token: requesterToken,
      body: {
        taskId,
        aiSummary: "OpenClaw host adapter local e2e task",
        tags: ["e2e", "openclaw", "host"],
        acceptanceCriteria: [
          { id: "c1", description: "Task is claimed and executed through worker run tools", fundWeight: 50 },
          { id: "c2", description: "Approval and review states sync back into the platform", fundWeight: 50 },
        ],
      },
    });

    const wizardDraft = await api<WizardDraftResponse>(baseUrl, `/api/wizard/${taskId}`, {
      token: requesterToken,
    });
    assert.equal(wizardDraft.task.taskHash, confirm.confirmedHash, "wizard confirm hash should persist");

    const rewardAmount = parseEther("0.0001");
    const requesterDeposit = parseEther(confirm.requesterDeposit);
    const totalEscrowAmount = rewardAmount + requesterDeposit;
    const createEscrowTx = await requesterClient.createEscrow(
      {
        taskHash: confirm.confirmedHash as `0x${string}`,
        deliveryDurationSeconds: 7n * 24n * 60n * 60n,
        maxRevisions: 2,
        acceptanceWindowHours: 48,
        criteriaCount: 2,
        fundWeights: [50, 50],
        token: ZERO_ADDRESS,
        totalAmount: totalEscrowAmount,
      },
      totalEscrowAmount
    );
    await publicClient.waitForTransactionReceipt({ hash: createEscrowTx });

    const createdTask = await waitFor("task CREATED sync", async () => {
      const response = await api<{ task: TaskRecord }>(baseUrl, `/api/tasks/${taskId}`, {
        token: requesterToken,
      });
      return response.task.status === "CREATED" && response.task.escrowId ? response.task : null;
    });
    const escrowId = BigInt(createdTask.escrowId!);

    await providerControlAgent.bidOnTask(taskId, "OpenClaw host adapter e2e bid");
    await api(baseUrl, "/api/matching/select-provider", {
      method: "POST",
      token: requesterToken,
      body: {
        taskId,
        providerId: providerAuth.user.id,
      },
    });
    await api(baseUrl, "/api/escrow/assign", {
      method: "POST",
      token: requesterToken,
      body: {
        taskId,
        agentAddress: providerAccount.address,
      },
    });
    await waitFor("ASSIGNMENT_SIGNATURE event", async () => seenEvents.ASSIGNMENT_SIGNATURE, 30000, 500);

    const hostFlow = await withHostPluginEnvironment(
      {
        providerPk,
        providerToken,
        platformUrl: baseUrl,
        rpcUrl: chainConfig.rpcUrl,
      },
      async (pluginApi) => {
        const session = getStructuredContent<{
          node: { id: string };
          run: { id: string; status: string };
          task: { access?: { assignmentRole?: string; canSelectedNodeClaim?: boolean } | null };
          brief: { pendingApprovals: unknown[]; suggestedNextActions?: string[] };
        }>(
          await pluginApi.getTool("agentpact_begin_task_session").execute({
            taskId,
            hostKind: "OPENCLAW",
            workerKey: "openclaw:local-e2e",
            displayName: "OpenClaw Local Host",
          }),
          "session"
        );
        assert.equal(session.run.status, "RUNNING", "begin_task_session should start a RUNNING worker run");
        assert.equal(session.brief.pendingApprovals.length, 0, "fresh session should not have pending approvals");

        const claimed = getStructuredContent<{
          txHash: string;
          run: { id: string; status: string };
          task: { access?: { assignmentRole?: string } | null };
        }>(
          await pluginApi.getTool("agentpact_claim_task_for_worker_run").execute({
            runId: session.run.id,
            taskId,
            percent: 12,
            currentStep: "Claiming assigned task from the OpenClaw host flow",
            summary: "Selected provider is claiming the task before protected execution.",
          }),
          "result"
        );
        assert.equal(claimed.run.status, "RUNNING", "claim_task_for_worker_run should keep the run active");

        await waitFor("task WORKING sync", async () => {
          const response = await api<{ task: TaskRecord }>(baseUrl, `/api/tasks/${taskId}`, {
            token: requesterToken,
          });
          return response.task.status === "WORKING" ? response.task : null;
        });

        const gated = getStructuredContent<{
          run: { status: string };
          approval: { id: string; status: string };
        }>(
          await pluginApi.getTool("agentpact_gate_worker_run_for_approval").execute({
            runId: session.run.id,
            taskId,
            kind: "STRATEGY_DECISION",
            title: "Owner approval required before publishing final artifact",
            summary: "The host wants confirmation before pushing a delivery that touches an external destination.",
            percent: 63,
            currentStep: "Waiting for owner sign-off on the publish step",
            runSummary: "Paused for owner approval before final publish.",
          }),
          "result"
        );
        assert.equal(gated.run.status, "WAITING_APPROVAL", "gate_worker_run_for_approval should pause the run");
        assert.equal(gated.approval.status, "PENDING", "approval should start pending");

        const approvalWaitPromise = pluginApi.getTool("agentpact_wait_for_approval_resolution").execute({
          approvalId: gated.approval.id,
          taskId,
          timeoutMs: 30000,
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        await providerControlAgent!.resolveApprovalRequest(gated.approval.id, {
          decision: "APPROVED",
          responseNote: "Approved by node owner during real host adapter e2e.",
        });
        const approvalWait = getStructuredContent<{
          timedOut: boolean;
          matchedEvent: string | null;
          approval: { id: string; status: string };
        }>(await approvalWaitPromise, "result");
        assert.equal(approvalWait.timedOut, false, "approval should resolve before timeout");
        assert.equal(approvalWait.matchedEvent, "NODE_APPROVAL_RESOLVED", "approval resolution should arrive via node event");
        assert.equal(approvalWait.approval.status, "APPROVED", "approval should resolve as approved");

        const resumed = getStructuredContent<{
          run: { id: string; status: string; currentStep?: string };
          approval: { id: string; status: string };
        }>(
          await pluginApi.getTool("agentpact_resume_worker_run_after_approval").execute({
            runId: session.run.id,
            approvalId: gated.approval.id,
            taskId,
            percent: 70,
            currentStep: "Owner approval resolved, resuming host execution",
            summary: "Owner approved the publish step; execution resumed.",
          }),
          "result"
        );
        assert.equal(resumed.run.status, "RUNNING", "approved run should resume to RUNNING");

        const deliveryHash = `0x${"22".repeat(32)}` as `0x${string}`;
        const delivered = getStructuredContent<{
          txHash: string;
          deliveryId: string;
          run: { status: string; currentStep?: string };
        }>(
          await pluginApi.getTool("agentpact_submit_delivery_for_worker_run").execute({
            runId: session.run.id,
            taskId,
            escrowId: escrowId.toString(),
            deliveryHash,
            content: "https://example.com/openclaw-host-local-e2e-delivery",
            artifacts: {
              notes: "Real host adapter e2e delivery artifact",
            },
            percent: 100,
            currentStep: "Delivery submitted, waiting for requester review",
            summary: "OpenClaw host adapter submitted delivery through worker run tooling.",
          }),
          "result"
        );
        assert.equal(delivered.run.status, "RUNNING", "run should stay active while requester review is pending");

        const requesterReviewWaitPromise = pluginApi.getTool("agentpact_wait_for_requester_review_outcome").execute({
          taskId,
          timeoutMs: 30000,
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        await api(baseUrl, "/api/acceptance", {
          method: "POST",
          token: requesterToken,
          body: {
            taskId,
            deliveryId: delivered.deliveryId,
            decision: "accept",
            criteriaResults: [
              {
                criterionId: "c1",
                description: "Task is claimed and executed through worker run tools",
                fundWeight: 50,
                status: "pass",
              },
              {
                criterionId: "c2",
                description: "Approval and review states sync back into the platform",
                fundWeight: 50,
                status: "pass",
              },
            ],
          },
        });
        const acceptTx = await requesterClient.acceptDelivery(escrowId);
        await publicClient.waitForTransactionReceipt({ hash: acceptTx });

        const requesterReview = getStructuredContent<{
          timedOut: boolean;
          matchedEvent: "TASK_ACCEPTED" | "REVISION_REQUESTED" | "TASK_SETTLED" | null;
          task: { status: string };
        }>(await requesterReviewWaitPromise, "result");
        assert.equal(requesterReview.timedOut, false, "requester review should arrive before timeout");
        assert.equal(requesterReview.matchedEvent, "TASK_ACCEPTED", "delivery should end in acceptance for the local e2e");
        assert.equal(requesterReview.task.status, "ACCEPTED", "task should be accepted before worker sync");

        const synced = getStructuredContent<{
          outcome: string;
          run: { id: string; status: string; currentStep?: string };
        }>(
          await pluginApi.getTool("agentpact_sync_worker_run_with_requester_review").execute({
            runId: session.run.id,
            outcome: "TASK_ACCEPTED",
          }),
          "result"
        );
        assert.equal(synced.run.status, "SUCCEEDED", "accepted requester review should close the run as succeeded");

        return {
          nodeId: session.node.id,
          runId: session.run.id,
          approvalId: gated.approval.id,
          deliveryId: delivered.deliveryId,
          finalRunStatus: synced.run.status,
          requesterOutcome: requesterReview.matchedEvent,
        };
      }
    );

    await waitFor("TASK_ACCEPTED event", async () => seenEvents.TASK_ACCEPTED, 30000, 500);
    await waitFor("action log records", async () => {
      const entries = await providerControlAgent!.getNodeActionLog({ taskId, limit: 50, offset: 0 });
      const events = new Set(entries.entries.map((entry: { event: string }) => entry.event));
      return events.has("NODE_WORKER_RUN_CREATED") &&
        events.has("NODE_APPROVAL_REQUESTED") &&
        events.has("NODE_APPROVAL_RESOLVED") &&
        events.has("NODE_WORKER_RUN_UPDATED")
        ? entries
        : null;
    }, 30000, 1000);

    const runs = await providerControlAgent.getNodeWorkerRuns({ taskId, limit: 20, offset: 0 });
    const finalRun = runs.find((run: { id: string }) => run.id === hostFlow.runId);
    assert.ok(finalRun, "final worker run should be queryable from node worker runs");
    assert.equal(finalRun?.status, "SUCCEEDED", "final worker run should be succeeded");

    const escrow = await requesterClient.getEscrow(escrowId);
    assert.equal(Number(escrow.state), 5, "escrow should end in ACCEPTED state");

    console.log("[host-e2e] passed");
    console.log(`[host-e2e] taskId=${taskId}`);
    console.log(`[host-e2e] escrowId=${escrowId.toString()}`);
    console.log(`[host-e2e] runId=${hostFlow.runId}`);
    console.log(`[host-e2e] approvalId=${hostFlow.approvalId}`);
    console.log(`[host-e2e] deliveryId=${hostFlow.deliveryId}`);
    console.log(
      `[host-e2e] workflow: requester=${hostFlow.requesterOutcome} finalRun=${hostFlow.finalRunStatus}`
    );
  } finally {
    providerControlAgent?.stop();
    await app.close();
  }
}

main().catch((error) => {
  console.error("[host-e2e] failed:", error);
  process.exit(1);
});
