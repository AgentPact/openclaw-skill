#!/bin/bash
# AgentPact OpenClaw setup (MCP-first mode)
#
# Installs @agentpactai/mcp-server and injects an OpenClaw MCP entry.
# The AgentPact OpenClaw plugin then provides the bundled skill, heartbeat,
# docs, templates, and integration guidance.

set -e

MCP_DIR="$HOME/.openclaw/mcp-servers/agentpact"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
ENV_FILE="$HOME/.openclaw/.env"
RPC_URL=""
PLATFORM_URL=""
JWT_TOKEN=""
AGENT_PK_VALUE=""
APPLY_CHANGES="false"

set_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"

  touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.bak"
  else
    if [ -s "$file" ] && [ "$(tail -c 1 "$file" 2>/dev/null || true)" != "" ]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

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
    --apply)
      APPLY_CHANGES="true"
      shift
      ;;
    --help)
      echo "Usage: bash setup.sh [--rpc URL] [--platform URL] [--jwt EXISTING_TOKEN] [--pk PRIVATE_KEY] [--apply]"
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
touch "$ENV_FILE"

echo ""
echo "Proposed OpenClaw MCP entry (mcpServers.agentpact):"
node -e "
const entry = '$MCP_ENTRY';
const rpcUrl = '$RPC_URL';
const platformUrl = '$PLATFORM_URL';
const env = {};
if (rpcUrl) env.AGENTPACT_RPC_URL = rpcUrl;
if (platformUrl) env.AGENTPACT_PLATFORM = platformUrl;
console.log(JSON.stringify({
  command: 'node',
  args: [entry],
  env,
}, null, 2));
"

echo ""
echo "Proposed .env entries:"
echo "AGENTPACT_AGENT_PK=${AGENT_PK_VALUE:-REPLACE_WITH_YOUR_PRIVATE_KEY}"
if [ -n "$JWT_TOKEN" ]; then
  echo "AGENTPACT_JWT_TOKEN=$JWT_TOKEN"
else
  echo "# AGENTPACT_JWT_TOKEN=<optional existing token>"
fi

if [ "$APPLY_CHANGES" = "true" ]; then
  CONFIG_BACKUP=""
  ENV_BACKUP=""

  if [ -f "$CONFIG_FILE" ]; then
    STAMP=$(date +%Y%m%d-%H%M%S)
    CONFIG_BACKUP="${CONFIG_FILE}.${STAMP}.bak"
    cp "$CONFIG_FILE" "$CONFIG_BACKUP"
  fi

  if [ -f "$ENV_FILE" ]; then
    STAMP=$(date +%Y%m%d-%H%M%S)
    ENV_BACKUP="${ENV_FILE}.${STAMP}.bak"
    cp "$ENV_FILE" "$ENV_BACKUP"
  fi

  set_env_line "$ENV_FILE" "AGENTPACT_AGENT_PK" "${AGENT_PK_VALUE:-REPLACE_WITH_YOUR_PRIVATE_KEY}"
  if [ -n "$JWT_TOKEN" ]; then
    set_env_line "$ENV_FILE" "AGENTPACT_JWT_TOKEN" "$JWT_TOKEN"
  fi

  node -e "
const fs = require('fs');
const path = '$CONFIG_FILE';
const entry = '$MCP_ENTRY';
const rpcUrl = '$RPC_URL';
const platformUrl = '$PLATFORM_URL';

let cfg = {};
try {
  if (fs.existsSync(path)) {
    const raw = fs.readFileSync(path, 'utf8');
    if (raw.trim()) {
      cfg = JSON.parse(raw);
    }
  }
} catch (e) {
  console.error('Failed to parse existing OpenClaw config at ' + path);
  console.error('The setup script will not overwrite an unreadable config file.');
  console.error(e.message);
  process.exit(1);
}

cfg.mcpServers = cfg.mcpServers || {};
const env = {};
if (rpcUrl) env.AGENTPACT_RPC_URL = rpcUrl;
if (platformUrl) env.AGENTPACT_PLATFORM = platformUrl;

cfg.mcpServers.agentpact = {
  command: 'node',
  args: [entry],
  env,
};

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('Updated MCP config at ' + path);
"
fi

echo ""
echo "AgentPact MCP setup complete."
echo "MCP entry:   $MCP_ENTRY"
[ -n "$MCP_VERSION" ] && echo "MCP version: $MCP_VERSION (installed via @latest)"
echo "Config file: $CONFIG_FILE"
echo "Env file:    $ENV_FILE"
[ "$APPLY_CHANGES" = "true" ] && echo "Changes:     applied"
[ "$APPLY_CHANGES" != "true" ] && echo "Changes:     dry run only (no config files were modified)"
[ "$APPLY_CHANGES" = "true" ] && [ -n "${CONFIG_BACKUP:-}" ] && echo "Config backup: $CONFIG_BACKUP"
[ "$APPLY_CHANGES" = "true" ] && [ -n "${ENV_BACKUP:-}" ] && echo "Env backup:    $ENV_BACKUP"
[ -n "$PLATFORM_URL" ] && echo "Platform:    $PLATFORM_URL"
[ -n "$RPC_URL" ] && echo "RPC URL:     $RPC_URL"
[ "$APPLY_CHANGES" = "true" ] && [ -z "$AGENT_PK_VALUE" ] && echo "Set AGENTPACT_AGENT_PK in the OpenClaw .env file before using AgentPact."
echo ""
echo "This repository now assumes MCP-first usage:"
echo "- mcp handles the AgentPact tools"
echo "- the AgentPact OpenClaw plugin provides the bundled skill, heartbeat, docs, and templates"
echo ""
if [ "$APPLY_CHANGES" = "true" ]; then
  echo "Restart OpenClaw to load the MCP server configuration."
else
  echo "Review the proposed config above. Re-run with --apply to write changes."
fi
