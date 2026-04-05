# Direct Live Tools In OpenClaw Plugin

## Goal

Make OpenClaw reach a true one-install setup for AgentPact:

1. install the plugin
2. set `AGENTPACT_AGENT_PK` in the OpenClaw env file
3. restart the gateway
4. immediately get both:
   - OpenClaw helper tools
   - live AgentPact action tools

Without requiring users to:

- hand-edit `openclaw.json`
- add `mcp.servers`
- manually manage `AGENTPACT_JWT_TOKEN`
- install a second visible integration surface

---

## Current code split

### 1. OpenClaw plugin layer

File:

- `openclaw-skill/src/index.ts`

What it does today:

- registers `agentpact_openclaw_*` helper tools
- checks plugin/env readiness
- manages local state/workspace/proposal/delivery helpers
- bundles skill, heartbeat, docs, and templates

What it does not do today:

- expose the live AgentPact action tools directly
- own the deterministic task lifecycle / wallet / on-chain tool surface

### 2. MCP live tool layer

File:

- `mcp/src/index.ts`

What it does today:

- creates a singleton `AgentPactAgent`
- starts WebSocket
- ensures provider profile
- registers the full live tool surface:
  - wallet
  - token balance / allowance
  - gas quote / preflight
  - approve token
  - transaction status / wait
  - task discovery / bidding / details
  - task lifecycle writes
  - notifications / polling
  - social tools
  - knowledge resource

### 3. Runtime deterministic layer

Files:

- `runtime/src/agent.ts`
- `runtime/src/client.ts`

What it already provides:

- auto-SIWE login when JWT is absent
- `ensureProviderProfile()`
- wallet helpers
- token helpers
- gas quote / preflight
- task lifecycle actions
- timeline / details / progress / notifications
- event subscriptions through WebSocket

This is the correct source of truth for deterministic behavior.

---

## Main design problem

Today the live action layer is implemented as:

`runtime -> MCP tool registration -> OpenClaw`

That means OpenClaw users effectively see two integration planes:

1. plugin plane
2. MCP plane

This breaks the desired product shape because:

- install is not one-shot
- troubleshooting becomes ambiguous
- secrets may drift into unsupported config paths
- helper tools and live tools can disagree about actual availability

---

## Design options

### Option A: Keep MCP as-is and shell into it from the plugin

Shape:

- plugin registers helper tools
- plugin internally spawns the local MCP server and proxies calls

Pros:

- low initial refactor cost
- keeps MCP implementation untouched

Cons:

- still effectively two layers
- harder error handling
- duplicated lifecycle / process management inside the plugin host
- keeps stdio-MCP semantics in a place that should be host-native
- does not really simplify the architecture

Verdict:

- not recommended

### Option B: Copy live tool implementations from `mcp/src/index.ts` into the plugin

Shape:

- plugin directly duplicates MCP tool handlers and swaps `server.registerTool()` for `api.registerTool()`

Pros:

- fast proof of concept
- could make one-install work quickly

Cons:

- guaranteed drift between MCP and plugin surfaces
- duplicated schema definitions
- duplicated error formatting
- duplicated agent bootstrap / event queue code
- every future tool change must be made twice

Verdict:

- acceptable only for a short-lived spike
- not recommended as the product architecture

### Option C: Extract a shared live tool registry and bind it from both MCP and OpenClaw

Shape:

- runtime stays deterministic core
- a shared host-agnostic live tool layer defines tool metadata + handler functions
- MCP adapter binds the shared definitions to `server.registerTool()`
- OpenClaw adapter binds the same shared definitions to `api.registerTool()`

Pros:

- one source of truth for live tools
- one-install OpenClaw path becomes possible
- MCP package still works for other hosts
- much lower long-term drift risk

Cons:

- requires a moderate refactor
- notifications/events/resources need careful host-specific treatment

Verdict:

- recommended

---

## Recommended target architecture

```text
@agentpactai/runtime
  - deterministic API / chain / websocket logic
  - AgentPactAgent

shared live-tool layer
  - tool definitions
  - input parsing
  - error formatting
  - singleton agent bootstrap
  - event queue helper

host adapters
  - MCP adapter
  - OpenClaw plugin adapter
```

Recommended module split:

### A. Shared Agent host context

Suggested new module:

- `runtime/src/host/context.ts`

Responsibility:

- resolve env-backed AgentPact config
- lazily create singleton `AgentPactAgent`
- call `ensureProviderProfile()`
- optionally start WebSocket once
- own the shared event queue abstraction

Suggested API:

```ts
type AgentPactHostContext = {
  getAgent(): Promise<AgentPactAgent>;
  getEventQueue(): AgentPactEventQueue;
  formatError(error: unknown, context: string): ToolTextResult;
  serialize(value: unknown): string;
};
```

### B. Shared live tool definitions

Suggested new module:

- `runtime/src/host/liveTools.ts`

Responsibility:

- define each live tool once
- keep names stable:
  - `agentpact_get_wallet_overview`
  - `agentpact_get_available_tasks`
  - `agentpact_confirm_task`
  - etc.

Suggested shape:

```ts
type AgentPactLiveToolSpec<TInput = unknown> = {
  name: string;
  title: string;
  description: string;
  readOnly?: boolean;
  idempotent?: boolean;
  inputSchema: ZodSchema<TInput>;
  run: (ctx: AgentPactHostContext, input: TInput) => Promise<AgentPactToolResult>;
};
```

### C. MCP adapter

Suggested module:

- `mcp/src/registerLiveTools.ts`

Responsibility:

- map shared tool specs into MCP `server.registerTool()`

### D. OpenClaw adapter

Suggested module:

- `openclaw-skill/src/registerLiveTools.ts`

Responsibility:

- map the same shared tool specs into OpenClaw `api.registerTool()`

---

## What should move first

Not all live tools have the same migration risk.

### Phase 1: move read-only and low-risk tools first

Recommended first batch:

- `agentpact_get_wallet_overview`
- `agentpact_get_token_balance`
- `agentpact_get_token_allowance`
- `agentpact_get_gas_quote`
- `agentpact_preflight_check`
- `agentpact_get_transaction_status`
- `agentpact_get_available_tasks`
- `agentpact_fetch_task_details`
- `agentpact_get_escrow`
- `agentpact_get_task_timeline`
- `agentpact_get_notifications`

Why:

- highest value for setup validation
- easiest to validate during real OpenClaw testing
- mostly direct wrappers around runtime methods
- low irreversible risk

### Phase 2: move controlled write tools

Recommended second batch:

- `agentpact_register_provider`
- `agentpact_bid_on_task`
- `agentpact_send_message`
- `agentpact_report_progress`
- `agentpact_confirm_task`
- `agentpact_decline_task`
- `agentpact_submit_delivery`
- `agentpact_abandon_task`
- timeout claim tools

Why:

- these are important for full parity
- but they should only move after shared preflight/error handling is stable

### Phase 3: host-sensitive tools

Keep for last:

- `agentpact_poll_events`
- knowledge resource
- any tool that depends on MCP-only resource semantics

Why:

- OpenClaw plugin tools are a good fit for callable tools
- resource semantics and long-lived event polling need a host-specific UX decision

---

## Why the shared registry is the right move

`mcp/src/index.ts` already shows the live tools are mostly thin wrappers around runtime methods.

Examples:

- `agentpact_get_wallet_overview` -> `agent.getWalletOverview()`
- `agentpact_preflight_check` -> `agent.preflightCheck()`
- `agentpact_register_provider` -> `agent.ensureProviderProfile()`
- `agentpact_get_available_tasks` -> `agent.getAvailableTasks()`
- `agentpact_submit_delivery` -> `agent.submitDelivery()`

That means the MCP layer is not adding much business logic.  
It is mainly adding:

- schema validation
- result formatting
- tool registration
- singleton agent bootstrap
- event queue plumbing

Those are exactly the parts that should be shared and host-adapted.

---

## Package impact

If OpenClaw plugin directly exposes live tools, `openclaw-skill/package.json` must stop being a pure helper bundle.

It should add runtime dependencies such as:

- `@agentpactai/runtime`
- `zod`

Potentially also:

- a shared internal package if the live tool registry is split out separately

This is acceptable and aligns with the product goal.  
The plugin package becomes the single OpenClaw distribution for AgentPact.

---

## Recommended implementation order

### Step 1

Extract shared bootstrap helpers from `mcp/src/index.ts`:

- env resolution
- error formatter
- serializer
- singleton `getAgent()`
- event queue helper

### Step 2

Extract the first 8-11 read-only live tools into a shared registry.

### Step 3

Bind that registry from:

- `mcp/src/index.ts`
- `openclaw-skill/src/index.ts`

### Step 4

Update OpenClaw docs so the product story becomes:

- install plugin
- add `AGENTPACT_AGENT_PK`
- restart
- use both helper and live tools immediately

### Step 5

Only after the OpenClaw plugin path is stable, decide whether the explicit OpenClaw MCP registration path should be:

- removed from docs entirely, or
- kept only as an advanced fallback for non-plugin hosts

---

## Practical recommendation for the next code pass

Do not start by moving all 20+ tools at once.

The best next implementation pass is:

1. create shared host context helpers
2. move wallet/discovery/preflight read-only tools first
3. prove that OpenClaw can call them directly with only plugin + `.env`

If that works, then the one-install story is already materially better even before the write tools move over.

---

## Bottom line

To truly achieve one-install OpenClaw integration, the live AgentPact tools should not remain MCP-only.

But they also should not be copied into the plugin as a second implementation.

The right direction is:

- keep runtime as deterministic core
- extract a shared live-tool registry
- bind it into both MCP and OpenClaw plugin hosts

That gives OpenClaw a true single-package installation path without sacrificing the generic MCP host story.
