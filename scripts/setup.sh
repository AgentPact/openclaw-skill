#!/bin/bash
# =============================================================================
# AgentPact MCP Server — Auto Installation Script
# =============================================================================
#
# This script installs the @agentpact/mcp-server and configures it in OpenClaw.
#
# Usage:
#   bash setup.sh
#   bash setup.sh --platform https://your-api.example.com
#
# After running, you MUST set your AGENT_PK in ~/.openclaw/openclaw.json
# =============================================================================

set -e

# --- Configuration ---
MCP_DIR="$HOME/.openclaw/mcp-servers/agentpact"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
DEFAULT_PLATFORM="https://api.agentpact.io"
PLATFORM_URL="$DEFAULT_PLATFORM"

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --platform)
      PLATFORM_URL="$2"
      shift 2
      ;;
    --pk)
      AGENT_PK_VALUE="$2"
      shift 2
      ;;
    --help)
      echo "Usage: bash setup.sh [--platform URL] [--pk PRIVATE_KEY]"
      echo ""
      echo "Options:"
      echo "  --platform URL    AgentPact platform API URL (default: $DEFAULT_PLATFORM)"
      echo "  --pk KEY          Agent private key (hex, without 0x prefix)"
      echo ""
      echo "Example:"
      echo "  bash setup.sh --platform http://192.168.1.10:8000 --pk abc123..."
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (use --help for usage)"
      exit 1
      ;;
  esac
done

# --- Check prerequisites ---
echo "🔍 Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not installed. Please install Node.js >= 18 first."
  echo "   https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js version must be >= 18 (current: $(node -v))"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ npm is not installed."
  exit 1
fi

echo "✅ Node.js $(node -v) and npm $(npm -v) found."

# --- Install MCP Server ---
echo ""
echo "📦 Installing @agentpact/mcp-server..."
mkdir -p "$MCP_DIR"
cd "$MCP_DIR"

# Initialize if needed
if [ ! -f "package.json" ]; then
  npm init -y > /dev/null 2>&1
fi

npm install @agentpact/mcp-server@latest --save 2>&1 | tail -3

# Resolve the entry point
MCP_ENTRY="$MCP_DIR/node_modules/@agentpact/mcp-server/dist/index.js"
if [ ! -f "$MCP_ENTRY" ]; then
  echo "❌ MCP Server entry point not found at: $MCP_ENTRY"
  echo "   The package may have a different structure. Please check manually."
  exit 1
fi

echo "✅ MCP Server installed at: $MCP_DIR"

# --- Configure OpenClaw ---
echo ""
echo "⚙️  Configuring OpenClaw..."

# Ensure config directory exists
mkdir -p "$(dirname "$CONFIG_FILE")"

# Create or update openclaw.json
node -e "
const fs = require('fs');
const path = '$CONFIG_FILE';
const entry = '$MCP_ENTRY';
const platform = '$PLATFORM_URL';
const pk = '${AGENT_PK_VALUE:-}';

let cfg = {};
try {
  if (fs.existsSync(path)) {
    // Strip JSON5 comments for basic parsing
    const raw = fs.readFileSync(path, 'utf8');
    cfg = JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  }
} catch (e) {
  console.log('⚠️  Could not parse existing config, creating new one.');
  cfg = {};
}

// Inject mcpServers.agentpact
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.agentpact = {
  command: 'node',
  args: [entry],
  env: {
    AGENT_PK: pk || '⚠️ REPLACE_WITH_YOUR_PRIVATE_KEY',
    AGENTPACT_PLATFORM: platform
  }
};

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('✅ MCP Server config injected into: ' + path);
"

# --- Summary ---
echo ""
echo "============================================="
echo "  🎉 AgentPact MCP Server Setup Complete!"
echo "============================================="
echo ""
echo "  MCP Server:  $MCP_DIR"
echo "  Config File: $CONFIG_FILE"
echo "  Platform:    $PLATFORM_URL"
echo ""

if [ -z "$AGENT_PK_VALUE" ]; then
  echo "  ⚠️  IMPORTANT: You still need to set your private key!"
  echo ""
  echo "  Edit ~/.openclaw/openclaw.json and replace:"
  echo '    "AGENT_PK": "⚠️ REPLACE_WITH_YOUR_PRIVATE_KEY"'
  echo "  with your actual wallet private key (hex, no 0x prefix)."
  echo ""
else
  echo "  ✅ Private key configured."
  echo ""
fi

echo "  Restart OpenClaw to activate the AgentPact tools."
echo "============================================="
