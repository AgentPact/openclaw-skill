#!/bin/bash
# AgentPact OpenClaw setup (MCP-first mode)
#
# Installs @agentpactai/mcp-server and injects an OpenClaw MCP entry.
# The openclaw-skill package then provides the bundled skill, heartbeat,
# docs, templates, and integration guidance.

set -e

MCP_DIR="$HOME/.openclaw/mcp-servers/agentpact"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
RPC_URL=""
PLATFORM_URL=""
JWT_TOKEN=""
AGENT_PK_VALUE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --rpc)
      RPC_URL="$2"
      shift 2
      ;;
    --platform)
      PLATFORM_URL="$2"
      shift 2
      ;;
    --jwt)
      JWT_TOKEN="$2"
      shift 2
      ;;
    --pk)
      AGENT_PK_VALUE="$2"
      shift 2
      ;;
    --help)
      echo "Usage: bash setup.sh [--rpc URL] [--platform URL] [--jwt TOKEN] [--pk PRIVATE_KEY]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "AgentPact OpenClaw setup (MCP-first mode)"
echo "Checking prerequisites..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Please install Node.js 18+ first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Node.js version must be >= 18 (current: $(node -v))"
  exit 1
fi

echo "Installing @agentpactai/mcp-server..."
mkdir -p "$MCP_DIR"
cd "$MCP_DIR"

if [ ! -f "package.json" ]; then
  npm init -y >/dev/null 2>&1
fi

npm install @agentpactai/mcp-server@latest --save 2>&1 | tail -3

MCP_ENTRY="$MCP_DIR/node_modules/@agentpactai/mcp-server/dist/index.js"
if [ ! -f "$MCP_ENTRY" ]; then
  echo "MCP server entry point not found at: $MCP_ENTRY"
  exit 1
fi

MCP_VERSION=$(node -p "try { require('$MCP_DIR/node_modules/@agentpactai/mcp-server/package.json').version } catch (e) { '' }")

mkdir -p "$(dirname "$CONFIG_FILE")"

node -e "
const fs = require('fs');
const path = '$CONFIG_FILE';
const entry = '$MCP_ENTRY';
const rpcUrl = '$RPC_URL';
const platformUrl = '$PLATFORM_URL';
const jwt = '$JWT_TOKEN';
const pk = '$AGENT_PK_VALUE';

let cfg = {};
try {
  if (fs.existsSync(path)) {
    const raw = fs.readFileSync(path, 'utf8');
    cfg = JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  }
} catch (e) {
  cfg = {};
}

cfg.mcpServers = cfg.mcpServers || {};
const env = { AGENT_PK: pk || 'REPLACE_WITH_YOUR_PRIVATE_KEY' };
if (rpcUrl) env.AGENTPACT_RPC_URL = rpcUrl;
if (platformUrl) env.AGENTPACT_PLATFORM = platformUrl;
if (jwt) env.AGENTPACT_JWT_TOKEN = jwt;

cfg.mcpServers.agentpact = {
  command: 'node',
  args: [entry],
  env,
};

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('Updated MCP config at ' + path);
"

echo ""
echo "AgentPact MCP setup complete."
echo "MCP entry:   $MCP_ENTRY"
[ -n "$MCP_VERSION" ] && echo "MCP version: $MCP_VERSION (installed via @latest)"
echo "Config file: $CONFIG_FILE"
[ -n "$PLATFORM_URL" ] && echo "Platform:    $PLATFORM_URL"
[ -n "$RPC_URL" ] && echo "RPC URL:     $RPC_URL"
[ -z "$AGENT_PK_VALUE" ] && echo "Set AGENT_PK in the MCP config before using AgentPact."
echo ""
echo "This repository now assumes MCP-first usage:"
echo "- mcp handles the AgentPact tools"
echo "- openclaw-skill provides the bundled skill, heartbeat, docs, and templates"
echo ""
echo "Restart OpenClaw to load the MCP server configuration."
