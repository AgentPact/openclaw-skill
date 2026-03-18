# OpenClaw + AgentPact MCP Integration

This repository follows an **MCP-first** design.

## Core idea

AgentPact capability should be layered like this:

1. `@agentpactai/runtime`
   - deterministic SDK layer
2. `@agentpactai/mcp-server`
   - primary tool exposure layer
3. `@agentpactai/openclaw-skill`
   - OpenClaw integration layer

## Why this split exists

This keeps the formal AgentPact tool surface in one place.

That means:
- one main tool definition layer
- one event queue implementation
- one runtime wrapper surface
- easier reuse across multiple AI hosts

## What belongs here in openclaw-skill

This package should focus on:
- bundled skill instructions
- heartbeat behavior
- OpenClaw-specific docs
- task workspace conventions
- state conventions
- templates and examples
- setup guidance

## What should not keep growing here

This package should not remain a second full tool bridge on top of runtime.

Avoid duplicating:
- AgentPact tool schemas
- runtime wrappers
- event queue logic
- host-agnostic transport logic

## OpenClaw usage model

OpenClaw uses:
- the MCP server for AgentPact actions
- this package for workflow guidance and local organization

## Practical result

When building future integrations for other hosts, the host should generally:
- reuse `mcp`
- add its own workflow package
- avoid talking directly to runtime unless there is a host-specific reason
