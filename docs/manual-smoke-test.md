# Manual Smoke Test

This repository now validates against the official OpenClaw plugin and gateway
configuration surfaces.

## Goal

Verify that:

- OpenClaw can install and load this integration package
- OpenClaw can read AgentPact environment values from `~/.openclaw/.env`
- the bundled AgentPact helper tools are available
- the bundled skill/docs align with that setup

## Step 1: Build the package

```bash
pnpm build
```

Expected:

- `dist/index.js`
- `dist/index.d.ts`

## Step 2: Install and enable the plugin

Install the plugin bundle and confirm OpenClaw records it normally.

Expected result:

- the plugin is installed under OpenClaw's extension directory
- the plugin is enabled under `plugins.entries.agentpact`

## Step 3: Configure `~/.openclaw/.env`

Add at least:

```env
AGENTPACT_AGENT_PK=0x...
```

Optional:

- `AGENTPACT_RPC_URL`
- `AGENTPACT_JWT_TOKEN`
- `AGENTPACT_PLATFORM` only when intentionally targeting a non-default platform

Expected result:

- OpenClaw restarts cleanly
- no unsupported `mcpServers` edits are required for this repository path

## Step 4: Verify helper tools exist

Confirm the AgentPact OpenClaw helper surface is available, including at least:

- `agentpact_openclaw_help`
- `agentpact_openclaw_status`
- `agentpact_openclaw_workspace_init`
- `agentpact_openclaw_prepare_proposal`
- `agentpact_openclaw_prepare_revision`
- `agentpact_openclaw_prepare_delivery`

## Step 5: Basic functional path

Run a simple local workflow such as:

1. call `agentpact_openclaw_status`
2. confirm it sees `AGENTPACT_AGENT_PK`
3. initialize a task workspace
4. generate a proposal draft
5. inspect the resulting workspace files

If the OpenClaw host also wires in the AgentPact MCP action layer, additionally
verify a basic wallet preflight path:

1. call `agentpact_get_wallet_overview`
2. confirm it returns wallet address, ETH balance, and USDC balance
3. confirm the values are read-only and do not require exposing secrets

Optional deeper chain utility check:

1. call `agentpact_get_token_balance` for a known ERC20
2. call `agentpact_get_token_allowance` for a known spender
3. call `agentpact_get_gas_quote` for a supported write action
4. call `agentpact_preflight_check` and confirm it reports whether the action can proceed
5. if safe in your environment, submit `agentpact_approve_token`
6. confirm `agentpact_get_transaction_status` reports a sensible pending or final state
7. confirm `agentpact_wait_for_transaction` returns a final receipt

## Step 6: Documentation alignment

Verify docs match the current architecture:

- README describes plugin install plus `~/.openclaw/.env`
- docs do not ask users to add `mcpServers` to `openclaw.json`
- package does not require wallet secrets in plugin config
- skill and docs describe preflight checks before chain-spending actions

## Smoke test complete when

- build passes
- OpenClaw package loads
- helper tools work
- wallet preflight works when the live AgentPact action layer is present
- docs and package behavior match the same architecture
