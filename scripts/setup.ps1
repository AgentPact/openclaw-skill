param(
    [string]$Rpc = "",
    [string]$Pk = "",
    [string]$Platform = "",
    [string]$Jwt = ""
)

$ErrorActionPreference = "Stop"

$mcpDir = Join-Path $HOME ".openclaw\mcp-servers\agentpact"
$configFile = Join-Path $HOME ".openclaw\openclaw.json"
$envFile = Join-Path $HOME ".openclaw\.env"
$mcpEntry = Join-Path $mcpDir "node_modules\@agentpactai\mcp-server\dist\index.js"
$mcpPackageJson = Join-Path $mcpDir "node_modules\@agentpactai\mcp-server\package.json"

function Set-EnvLine {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Value
    )

    $lines = @()
    if (Test-Path $Path) {
        $lines = Get-Content $Path
    }

    $entry = "$Name=$Value"
    $updated = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^$([regex]::Escape($Name))=") {
            $lines[$i] = $entry
            $updated = $true
        }
    }

    if (-not $updated) {
        $lines += $entry
    }

    Set-Content -Path $Path -Value $lines -Encoding utf8
}

Write-Host "AgentPact OpenClaw setup (MCP-first mode)"
Write-Host "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed. Install Node.js 18+ first."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is not installed."
}

$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 18) {
    throw "Node.js 18+ is required. Current version: $(node -v)"
}

Write-Host "Installing @agentpactai/mcp-server..."

New-Item -ItemType Directory -Force -Path $mcpDir | Out-Null
Push-Location $mcpDir

try {
    if (-not (Test-Path "package.json")) {
        npm init -y | Out-Null
    }

    npm install @agentpactai/mcp-server@latest --save | Out-Host

    if (-not (Test-Path $mcpEntry)) {
        throw "MCP server entry point not found at $mcpEntry"
    }
}
finally {
    Pop-Location
}

Write-Host "Updating OpenClaw MCP configuration..."

New-Item -ItemType Directory -Force -Path (Split-Path $configFile -Parent) | Out-Null
if (-not (Test-Path $envFile)) {
    New-Item -ItemType File -Force -Path $envFile | Out-Null
}

$cfg = @{}
if (Test-Path $configFile) {
    try {
        $raw = Get-Content $configFile -Raw
        $raw = [regex]::Replace($raw, '//.*$', '', 'Multiline')
        $raw = [regex]::Replace($raw, '/\*[\s\S]*?\*/', '')
        if ($raw.Trim()) {
            $cfg = $raw | ConvertFrom-Json -AsHashtable
        }
    }
    catch {
        $cfg = @{}
    }
}

if (-not $cfg.ContainsKey("mcpServers")) {
    $cfg["mcpServers"] = @{}
}

if ($Rpc) {
    $envMapRpc = $Rpc
}
if ($Platform) {
    $envMapPlatform = $Platform
}

Set-EnvLine -Path $envFile -Name "AGENTPACT_AGENT_PK" -Value $(if ($Pk) { $Pk } else { "REPLACE_WITH_YOUR_PRIVATE_KEY" })
if ($Jwt) {
    Set-EnvLine -Path $envFile -Name "AGENTPACT_JWT_TOKEN" -Value $Jwt
}

$cfg["mcpServers"]["agentpact"] = @{
    command = "node"
    args = @($mcpEntry)
    env = @{}
}

if ($Rpc) {
    $cfg["mcpServers"]["agentpact"]["env"]["AGENTPACT_RPC_URL"] = $Rpc
}
if ($Platform) {
    $cfg["mcpServers"]["agentpact"]["env"]["AGENTPACT_PLATFORM"] = $Platform
}

$cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $configFile

Write-Host ""
Write-Host "AgentPact MCP setup complete."
Write-Host "Config file: $configFile"
Write-Host "Env file:    $envFile"
Write-Host "MCP entry:   $mcpEntry"
if (Test-Path $mcpPackageJson) {
    try {
        $mcpPackage = Get-Content $mcpPackageJson -Raw | ConvertFrom-Json
        if ($mcpPackage.version) {
            Write-Host "MCP version: $($mcpPackage.version) (installed via @latest)"
        }
    }
    catch {
    }
}
if ($Platform) { Write-Host "Platform:    $Platform" }
if ($Rpc) { Write-Host "RPC URL:     $Rpc" }
if (-not $Pk) {
    Write-Host ""
    Write-Host "Set AGENTPACT_AGENT_PK in the OpenClaw .env file before using AgentPact."
}
Write-Host ""
Write-Host "This repository now assumes MCP-first usage:"
Write-Host "- mcp handles the AgentPact tools"
Write-Host "- the AgentPact OpenClaw plugin provides the bundled skill, heartbeat, docs, and templates"
Write-Host ""
Write-Host "Restart OpenClaw to load the MCP server configuration."
