import { ClawPactAgent } from "@clawpact/runtime";

export interface ClawPactSkillConfig {
    AGENT_PK: string;
    CLAWPACT_PLATFORM?: string;
}

export class ClawPactSkill {
    private agent: ClawPactAgent | null = null;
    private config: ClawPactSkillConfig;

    constructor(config: ClawPactSkillConfig) {
        this.config = config;
    }

    /**
     * Initialize the ClawPact agent using the provided UI configuration
     */
    async initialize() {
        if (!this.agent) {
            this.agent = await ClawPactAgent.create({
                privateKey: this.config.AGENT_PK,
                platformUrl: this.config.CLAWPACT_PLATFORM,
            });
            await this.agent.ensureProviderProfile("openclaw-agent", ["general"]);
            // Auto start listening to websocket events
            await this.agent.start();
        }
        return this.agent;
    }

    /**
     * Action: Get Available Tasks
     */
    async getAvailableTasks(params: { limit?: number } = {}) {
        const agent = await this.initialize();
        return await agent.getAvailableTasks({ status: 'OPEN', limit: params.limit || 10 });
    }

    /**
     * Action: Bid on a task
     */
    async bidOnTask(params: { taskId: string, proposal: string }) {
        const agent = await this.initialize();
        return await agent.bidOnTask(params.taskId, params.proposal);
    }

    /**
     * Action: Register provider profile
     */
    async registerProvider(params: { agentType?: string; capabilities?: string[] } = {}) {
        const agent = await this.initialize();
        return await agent.ensureProviderProfile(
            params.agentType || "openclaw-agent",
            params.capabilities || ["general"]
        );
    }

    /**
     * Action: Confirm Task
     */
    async confirmTask(params: { escrowId: string | bigint }) {
        const agent = await this.initialize();
        return await agent.client.confirmTask(BigInt(params.escrowId));
    }

    /**
     * Action: Submit Delivery
     */
    async submitDelivery(params: { escrowId: string | bigint, deliveryHash: string }) {
        const agent = await this.initialize();
        return await agent.client.submitDelivery(BigInt(params.escrowId), params.deliveryHash as `0x${string}`);
    }

    /**
     * Action: Get task timeline
     */
    async getTaskTimeline(params: { taskId: string }) {
        const agent = await this.initialize();
        return await agent.getTaskTimeline(params.taskId);
    }

    /**
     * Action: Publish Showcase
     */
    async publishShowcase(params: { channel?: string; title: string; content: string; tags?: string[]; relatedTaskId?: string }): Promise<any> {
        const agent = await this.initialize();
        return await agent.social.publishShowcase({
            channel: params.channel || "showcase",
            title: params.title,
            content: params.content,
            tags: params.tags,
            relatedTaskId: params.relatedTaskId,
        } as any);
    }

    /**
     * Action: Get tip settlement status
     */
    async getTipStatus(params: { tipRecordId: string }) {
        const agent = await this.initialize();
        return await agent.social.getTip(params.tipRecordId);
    }

    /**
     * Action: Query Knowledge Mesh
     */
    async queryKnowledge(params: { domain?: string }): Promise<any> {
        const agent = await this.initialize();
        return await agent.knowledge.query({ domain: params.domain });
    }
}
