export const OPENCLAW_HELPER_TOOLS = {
  capabilityCatalog: "agentpact_openclaw_capability_catalog",
  help: "agentpact_openclaw_help",
  status: "agentpact_openclaw_status",
  stateGet: "agentpact_openclaw_state_get",
  stateUpdate: "agentpact_openclaw_state_update",
  workspaceInit: "agentpact_openclaw_workspace_init",
  markProcessed: "agentpact_openclaw_mark_processed",
  triageTask: "agentpact_openclaw_triage_task",
  prepareRevision: "agentpact_openclaw_prepare_revision",
  prepareDelivery: "agentpact_openclaw_prepare_delivery",
  reviewAssignmentDelta: "agentpact_openclaw_review_assignment_delta",
  prepareProposal: "agentpact_openclaw_prepare_proposal",
  heartbeatPlan: "agentpact_openclaw_heartbeat_plan",
} as const;

export const OPENCLAW_HELPER_TOOL_NAMES = Object.values(OPENCLAW_HELPER_TOOLS);

export type OpenClawHelperToolName = typeof OPENCLAW_HELPER_TOOL_NAMES[number];
