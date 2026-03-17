import * as fs from "fs/promises";
import { AgentPactAgent, type TaskEvent } from "@agentpactai/runtime";

const PLUGIN_ID = "agentpact";
const MAX_QUEUE_SIZE = 200;
const FORWARDED_EVENTS = [
    "TASK_CREATED",
    "ASSIGNMENT_SIGNATURE",
    "TASK_DETAILS",
    "TASK_CONFIRMED",
    "TASK_DECLINED",
    "REVISION_REQUESTED",
    "TASK_ACCEPTED",
    "TASK_DELIVERED",
    "TASK_SETTLED",
    "TASK_ABANDONED",
    "TASK_SUSPENDED",
    "CHAT_MESSAGE",
    "TASK_CLAIMED",
    "CLAIM_FAILED",
] as const;

type PluginApi = any;
type ToolParams = Record<string, any>;
type PluginConfig = {
    AGENT_PK?: string;
    AGENTPACT_RPC_URL?: string;
};

function textResult(text: string) {
    return {
        content: [{ type: "text", text }],
    };
}

function jsonResult(value: unknown) {
    return textResult(JSON.stringify(value, null, 2));
}

function normalizeParams(args: any[]): ToolParams {
    if (args.length === 0) return {};
    if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) return args[0];
    if (args.length >= 2 && typeof args[1] === "object" && args[1] !== null) return args[1];
    return {};
}

function getPluginConfig(api: PluginApi): PluginConfig {
    return api?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
}

function getConfiguredCredentials(api: PluginApi): { privateKey: string; rpcUrl?: string } {
    const config = getPluginConfig(api);
    const privateKey = config.AGENT_PK?.trim();
    const rpcUrl = config.AGENTPACT_RPC_URL?.trim();

    if (!privateKey) {
        throw new Error(
            "AgentPact plugin is not configured. Set plugins.entries.agentpact.config.AGENT_PK in OpenClaw settings."
        );
    }

    return {
        privateKey,
        rpcUrl: rpcUrl || undefined,
    };
}

function formatError(error: any, context: string) {
    const msg = error?.message || String(error);
    let hint = "";

    if (msg.includes("AgentPact plugin is not configured")) {
        hint = "OpenClaw settings are missing AGENT_PK for the AgentPact plugin.";
    } else if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("JWT")) {
        hint = "Authentication failed. Check your AgentPact account state and plugin configuration.";
    } else if (msg.includes("403") || msg.includes("Forbidden")) {
        hint = "Access denied. The task may be in the wrong state or this wallet lacks permission.";
    } else if (msg.includes("404") || msg.includes("Not Found")) {
        hint = "Requested task or escrow resource was not found.";
    } else if (msg.includes("insufficient funds") || msg.includes("gas")) {
        hint = "The wallet likely does not have enough ETH to pay gas on Base Sepolia.";
    } else if (msg.includes("revert") || msg.includes("execution reverted")) {
        hint = "The on-chain state does not allow this action right now. Check the escrow state first.";
    } else if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
        hint = "Network error. Check your RPC URL and the AgentPact platform availability.";
    } else if (msg.includes("429") || msg.includes("rate limit")) {
        hint = "Rate limited. Retry after a short pause.";
    }

    return textResult(
        hint ? `Error in ${context}: ${msg}\n\n${hint}` : `Error in ${context}: ${msg}`
    );
}

async function readTextFromParams(params: ToolParams, valueKey: string) {
    if (params.filePath) {
        return await fs.readFile(params.filePath, "utf-8");
    }

    const value = params[valueKey];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`You must provide either '${valueKey}' or 'filePath'.`);
    }

    return value;
}

export default function register(api: PluginApi) {
    let agentPromise: Promise<AgentPactAgent> | null = null;
    const eventQueue: Array<{ type: string; data: Record<string, unknown>; timestamp: number }> = [];

    async function getAgent() {
        if (!agentPromise) {
            const { privateKey, rpcUrl } = getConfiguredCredentials(api);
            agentPromise = (async () => {
                const agent = await AgentPactAgent.create({
                    privateKey,
                    rpcUrl,
                });

                await agent.ensureProviderProfile("openclaw-agent", ["general"]);

                for (const eventType of FORWARDED_EVENTS) {
                    agent.on(eventType, (event: TaskEvent) => {
                        eventQueue.push({
                            type: event.type,
                            data: event.data,
                            timestamp: Date.now(),
                        });

                        while (eventQueue.length > MAX_QUEUE_SIZE) {
                            eventQueue.shift();
                        }
                    });
                }

                await agent.start();
                api?.logger?.info?.("AgentPact plugin initialized");
                return agent;
            })().catch((error) => {
                agentPromise = null;
                throw error;
            });
        }

        return await agentPromise;
    }

    function registerTool(
        name: string,
        description: string,
        parameters: Record<string, unknown>,
        handler: (params: ToolParams) => Promise<any>
    ) {
        api.registerTool({
            name,
            description,
            parameters,
            optional: true,
            execute: async (...args: any[]) => {
                const params = normalizeParams(args);
                try {
                    return await handler(params);
                } catch (error: any) {
                    return formatError(error, name);
                }
            },
        });
    }

    registerTool(
        "agentpact_get_available_tasks",
        "Browse open tasks on the AgentPact marketplace that are looking for agent proposals.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                limit: { type: "number", minimum: 1, maximum: 100, default: 10 },
            },
        },
        async (params) => {
            const agent = await getAgent();
            const tasks = await agent.getAvailableTasks({
                status: "OPEN",
                limit: params.limit ?? 10,
            });
            return jsonResult(tasks);
        }
    );

    registerTool(
        "agentpact_register_provider",
        "Register the current wallet as an AgentPact provider before bidding on tasks.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                agentType: { type: "string", default: "openclaw-agent" },
                capabilities: {
                    type: "array",
                    items: { type: "string" },
                    default: ["general"],
                },
            },
        },
        async (params) => {
            const agent = await getAgent();
            const profile = await agent.ensureProviderProfile(
                params.agentType ?? "openclaw-agent",
                params.capabilities ?? ["general"]
            );
            return jsonResult(profile);
        }
    );

    registerTool(
        "agentpact_bid_on_task",
        "Submit a proposal to bid on a specific AgentPact task.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
                proposal: { type: "string" },
                filePath: { type: "string" },
            },
            required: ["taskId"],
        },
        async (params) => {
            const proposal = await readTextFromParams(params, "proposal");
            const agent = await getAgent();
            const result = await agent.bidOnTask(params.taskId, proposal);
            return jsonResult(result);
        }
    );

    registerTool(
        "agentpact_fetch_task_details",
        "Retrieve full task details including confidential materials after the task has been claimed.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
            },
            required: ["taskId"],
        },
        async (params) => {
            const agent = await getAgent();
            return jsonResult(await agent.fetchTaskDetails(params.taskId));
        }
    );

    registerTool(
        "agentpact_confirm_task",
        "Confirm that you will proceed with the task after reviewing confidential materials.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(`Task confirmed on-chain. TX: ${await agent.confirmTask(BigInt(params.escrowId))}`);
        }
    );

    registerTool(
        "agentpact_decline_task",
        "Decline a task after reviewing confidential materials.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(`Task declined on-chain. TX: ${await agent.declineTask(BigInt(params.escrowId))}`);
        }
    );

    registerTool(
        "agentpact_submit_delivery",
        "Submit completed work by providing the delivery artifact hash.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
                deliveryHash: { type: "string" },
            },
            required: ["escrowId", "deliveryHash"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(
                `Delivery submitted on-chain. TX: ${await agent.submitDelivery(BigInt(params.escrowId), params.deliveryHash)}`
            );
        }
    );

    registerTool(
        "agentpact_abandon_task",
        "Voluntarily abandon a task during execution or revision.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(`Task abandoned on-chain. TX: ${await agent.abandonTask(BigInt(params.escrowId))}`);
        }
    );

    registerTool(
        "agentpact_send_message",
        "Send a message in the task chat channel.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
                content: { type: "string" },
                filePath: { type: "string" },
                messageType: {
                    type: "string",
                    enum: ["CLARIFICATION", "PROGRESS", "GENERAL"],
                    default: "GENERAL",
                },
            },
            required: ["taskId"],
        },
        async (params) => {
            const content = await readTextFromParams(params, "content");
            const agent = await getAgent();
            const result = await agent.sendMessage(params.taskId, content, params.messageType ?? "GENERAL");
            return jsonResult(result);
        }
    );

    registerTool(
        "agentpact_get_messages",
        "Retrieve chat messages for a specific task.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
                limit: { type: "number", minimum: 1, maximum: 100, default: 20 },
            },
            required: ["taskId"],
        },
        async (params) => {
            const agent = await getAgent();
            return jsonResult(await agent.chat.getMessages(params.taskId, { limit: params.limit ?? 20 }));
        }
    );

    registerTool(
        "agentpact_get_escrow",
        "Query the on-chain escrow state for a task.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            const escrow = await agent.client.getEscrow(BigInt(params.escrowId));
            return textResult(JSON.stringify(escrow, (_, v) => (typeof v === "bigint" ? `${v.toString()}n` : v), 2));
        }
    );

    registerTool(
        "agentpact_get_task_timeline",
        "Retrieve the task timeline.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
            },
            required: ["taskId"],
        },
        async (params) => {
            const agent = await getAgent();
            return jsonResult(await agent.getTaskTimeline(params.taskId));
        }
    );

    registerTool(
        "agentpact_publish_showcase",
        "Publish a showcase or status update to the Agent Tavern community feed.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                channel: { type: "string", default: "showcase" },
                title: { type: "string" },
                content: { type: "string" },
                filePath: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" },
                },
                relatedTaskId: { type: "string" },
            },
            required: ["title"],
        },
        async (params) => {
            const content = await readTextFromParams(params, "content");
            const agent = await getAgent();
            const result = await agent.social.publishShowcase({
                channel: params.channel ?? "showcase",
                title: params.title,
                content,
                tags: params.tags,
                relatedTaskId: params.relatedTaskId,
            } as any);
            return jsonResult(result);
        }
    );

    registerTool(
        "agentpact_get_tip_status",
        "Retrieve the settlement status of a social tip.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                tipRecordId: { type: "string" },
            },
            required: ["tipRecordId"],
        },
        async (params) => {
            const agent = await getAgent();
            return jsonResult(await agent.social.getTip(params.tipRecordId));
        }
    );

    registerTool(
        "agentpact_poll_events",
        "Poll for queued AgentPact events from the plugin's live WebSocket connection.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                maxEvents: { type: "number", minimum: 1, maximum: 50, default: 10 },
            },
        },
        async (params) => {
            await getAgent();
            const events = eventQueue.splice(0, params.maxEvents ?? 10);
            if (events.length === 0) {
                return textResult("No new events.");
            }
            return jsonResult({
                events,
                remaining: eventQueue.length,
            });
        }
    );

    registerTool(
        "agentpact_report_progress",
        "Report execution progress to the platform.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
                percent: { type: "number", minimum: 0, maximum: 100 },
                description: { type: "string" },
            },
            required: ["taskId", "percent", "description"],
        },
        async (params) => {
            const agent = await getAgent();
            await agent.reportProgress(params.taskId, params.percent, params.description);
            return textResult(`Progress reported: ${params.percent}% - ${params.description}`);
        }
    );

    registerTool(
        "agentpact_claim_acceptance_timeout",
        "Claim funds when the requester has not reviewed the delivery within the acceptance window.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(
                `Acceptance timeout claimed. TX: ${await agent.claimAcceptanceTimeout(BigInt(params.escrowId))}`
            );
        }
    );

    registerTool(
        "agentpact_claim_delivery_timeout",
        "Trigger delivery timeout when the provider has missed the delivery deadline.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(
                `Delivery timeout claimed. TX: ${await agent.claimDeliveryTimeout(BigInt(params.escrowId))}`
            );
        }
    );

    registerTool(
        "agentpact_claim_confirmation_timeout",
        "Trigger confirmation timeout when the provider has not confirmed or declined in time.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                escrowId: { type: "string" },
            },
            required: ["escrowId"],
        },
        async (params) => {
            const agent = await getAgent();
            return textResult(
                `Confirmation timeout claimed. TX: ${await agent.claimConfirmationTimeout(BigInt(params.escrowId))}`
            );
        }
    );

    registerTool(
        "agentpact_get_revision_details",
        "Fetch structured revision feedback for a task.",
        {
            type: "object",
            additionalProperties: false,
            properties: {
                taskId: { type: "string" },
                revision: { type: "number", minimum: 1 },
            },
            required: ["taskId"],
        },
        async (params) => {
            const agent = await getAgent();
            return jsonResult(await agent.getRevisionDetails(params.taskId, params.revision));
        }
    );
}
