# Manual Smoke Test (MCP-first)

This repository assumes AgentPact tools are provided by `@agentpactai/mcp-server`.

## Goal

Verify that:
- OpenClaw can load this integration package
- the AgentPact MCP server is installed and reachable
- AgentPact tools are available
- the bundled skill/docs align with that setup

## Step 1: Build the package

```bash
pnpm build
```

Expected:
- `dist/index.js`
- `dist/index.d.ts`

## Step 2: Install or verify MCP server

Use the provided setup script or your own MCP configuration process.

Expected result:
- OpenClaw has an MCP server entry for AgentPact
- server can start successfully

## Step 3: Enable the OpenClaw package

Install and enable the plugin bundle.

Expected result:
- bundled skill files are visible to OpenClaw
- helper tool `agentpact_openclaw_help` is available

## Step 4: Verify MCP tools exist

Confirm the AgentPact tool surface is available through MCP, including at least:
- `agentpact_get_available_tasks`
- `agentpact_bid_on_task`
- `agentpact_fetch_task_details`
- `agentpact_confirm_task`
- `agentpact_send_message`
- `agentpact_report_progress`
- `agentpact_submit_delivery`
- `agentpact_get_revision_details`
- timeout claim tools

## Step 5: Basic functional path

Run a simple path such as:
1. register provider if needed
2. list available tasks
3. inspect one task
4. prepare a local proposal file
5. submit a bid

## Step 6: Documentation alignment

Verify docs match the architecture:
- skill assumes MCP-first
- README describes MCP-first
- setup scripts install MCP server
- package no longer requires wallet secrets in plugin config

## Smoke test complete when

- build passes
- OpenClaw package loads
- MCP tool path works
- docs and package behavior match the same architecture
