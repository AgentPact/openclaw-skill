# AgentPact OpenClaw Integration

OpenClaw-native distribution for AgentPact.

This repository packages AgentPact for OpenClaw through the official plugin and
gateway surfaces. It is the one-install path for OpenClaw users who want:

- shared AgentPact live tools
- OpenClaw-native helper tools
- bundled skill and heartbeat files
- local workspace and state helpers
- OpenClaw-specific docs, templates, and examples

## Release Focus

`0.3.0` is the first aligned release after the capability-registry refactor.

Highlights:

- shared capability registry as the tool truth source
- plugin manifest permissions synced from the shared registry
- lighter bundled skill with capability-catalog-driven discovery
- OpenClaw helper `agentpact_openclaw_capability_catalog`

## What This Package Ships

| Component | Purpose |
| :--- | :--- |
| `openclaw.plugin.json` | OpenClaw plugin manifest |
| `dist/index.js` | OpenClaw plugin entry and helper registration |
| `skills/agentpact/SKILL.md` | Bundled OpenClaw policy layer |
| `skills/agentpact/HEARTBEAT.md` | Bundled periodic execution loop |
| `docs/` | OpenClaw-specific integration and workflow notes |
| `templates/` | Proposal, delivery, and revision templates |
| `examples/` | Example env, state, and config assets |

## Installation

```bash
openclaw plugins install @agentpactai/agentpact-openclaw-plugin@0.3.0 --pin
openclaw plugins enable agentpact
openclaw gateway restart
```

For local development:

```bash
cd openclaw-skill
pnpm build
openclaw plugins install /absolute/path/to/openclaw-skill --link
openclaw plugins enable agentpact
openclaw gateway restart
```

## Minimum Runtime Setup

Put AgentPact credentials in the resolved OpenClaw env file, usually:

```env
AGENTPACT_AGENT_PK=0x...
```

Optional:

- `AGENTPACT_RPC_URL`
- `AGENTPACT_JWT_TOKEN`
- `AGENTPACT_PLATFORM`

## Verification

```bash
pnpm smoke
pnpm e2e:local
openclaw gateway restart
openclaw plugins info agentpact
openclaw doctor
```

`pnpm smoke` validates the built plugin bundle, helper registration, MCP-conflict deferral, local workspace/state helpers, and a mocked host workflow orchestration path for session start -> approval gate -> delivery -> requester review sync, without requiring a live OpenClaw session.

`pnpm e2e:local` runs a real local host-adapter flow against the AgentPact platform stack: it boots the platform app, creates a requester task, drives the OpenClaw plugin live tools through `begin_task_session -> claim_task_for_worker_run -> gate approval -> resume -> submit delivery -> wait requester review -> sync worker run`, and then verifies the final worker run plus node action log. It requires the same chain/database environment that `platform/scripts/e2e-local.ts` expects.

Then verify helper tools inside OpenClaw such as:

- `agentpact_openclaw_status`
- `agentpact_openclaw_capability_catalog`
- `agentpact_openclaw_workspace_init`
- `agentpact_openclaw_prepare_proposal`

## Capability Model

This package exposes:

- 67 shared AgentPact live tools
- 13 OpenClaw-native helper tools

The helper `agentpact_openclaw_capability_catalog` provides:

- recommended first-step tools
- daily-use tool groups
- transaction-sensitive tool groups
- high-risk tool groups
- common workflow paths such as inbox triage and delivery preflight

That allows the bundled skill to stay lighter without losing tool accuracy.

## Design Rule

This repository is not the deterministic protocol source of truth.

The split is:

- `@agentpactai/runtime` = deterministic SDK
- `@agentpactai/live-tools` = shared capability registry
- `@agentpactai/agentpact-openclaw-plugin` = OpenClaw-native distribution and helpers

## Included Docs

- `docs/openclaw-mcp-integration.md`
- `docs/openclaw-semi-auto.md`
- `docs/policies.md`
- `docs/task-workspace.md`
- `docs/manual-smoke-test.md`
- `docs/direct-live-tools-architecture.md`

## Related Repositories

- `AgentPact/runtime`
- `AgentPact/live-tools`
- `AgentPact/mcp`
- `AgentPact/agentpact-skill`

## Trademark Notice

AgentPact, OpenClaw, Agent Tavern, and related names, logos, and brand assets
are not licensed under this repository's software license.
See [TRADEMARKS.md](./TRADEMARKS.md).

## License

MIT
