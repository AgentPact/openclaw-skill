param(
    [string]$Rpc = "",
    [string]$Pk = "",
    [string]$Platform = "",
    [string]$Jwt = "",
    [switch]$Apply
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
        $raw = [System.IO.File]::ReadAllText($Path)
        if ($raw.Length -gt 0) {
            $normalized = $raw -replace "(\r?\n)$", ""
            if ($normalized.Length -gt 0) {
                $lines = $normalized -split "\r?\n"
            }
        }
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

    $content = if ($lines.Count -gt 0) {
        ($lines -join "`r`n") + "`r`n"
    }
    else {
        "$entry`r`n"
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

function Read-JsonConfigAsHashtable {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return @{}
    }

    $raw = Get-Content $Path -Raw
    if (-not $raw.Trim()) {
        return @{}
    }

    try {
        return $raw | ConvertFrom-Json -AsHashtable
    }
    catch {
        throw "Failed to parse existing OpenClaw config at $Path. The setup script will not overwrite an unreadable config file."
    }
}

function Backup-FileIfExists {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$Path.$stamp.bak"
    Copy-Item -Path $Path -Destination $backupPath -Force
    return $backupPath
}

function Write-JsonFileNoBom {
    param(
        [string]$Path,
        [object]$Value
    )

    $jsonOut = $Value | ConvertTo-Json -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $jsonOut + "`r`n", $utf8NoBom)
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

Write-Host "Preparing OpenClaw MCP configuration..."

New-Item -ItemType Directory -Force -Path (Split-Path $configFile -Parent) | Out-Null
if (-not (Test-Path $envFile)) {
    New-Item -ItemType File -Force -Path $envFile | Out-Null
}

$proposedServerConfig = @{
    command = "node"
    args = @($mcpEntry)
    env = @{}
}

if ($Rpc) {
    $proposedServerConfig["env"]["AGENTPACT_RPC_URL"] = $Rpc
}
if ($Platform) {
    $proposedServerConfig["env"]["AGENTPACT_PLATFORM"] = $Platform
}

Write-Host ""
Write-Host "Proposed OpenClaw MCP entry (mcpServers.agentpact):"
$proposedServerConfig | ConvertTo-Json -Depth 10 | Write-Host

Write-Host ""
Write-Host "Proposed .env entries:"
Write-Host "AGENTPACT_AGENT_PK=$(if ($Pk) { $Pk } else { 'REPLACE_WITH_YOUR_PRIVATE_KEY' })"
if ($Jwt) {
    Write-Host "AGENTPACT_JWT_TOKEN=$Jwt"
}
else {
    Write-Host "# AGENTPACT_JWT_TOKEN=<optional existing token>"
}

$configBackupPath = $null
$envBackupPath = $null

if ($Apply) {
    $cfg = Read-JsonConfigAsHashtable -Path $configFile

    if (-not $cfg.ContainsKey("mcpServers")) {
        $cfg["mcpServers"] = @{}
    }

    $configBackupPath = Backup-FileIfExists -Path $configFile
    $envBackupPath = Backup-FileIfExists -Path $envFile

    Set-EnvLine -Path $envFile -Name "AGENTPACT_AGENT_PK" -Value $(if ($Pk) { $Pk } else { "REPLACE_WITH_YOUR_PRIVATE_KEY" })
    if ($Jwt) {
        Set-EnvLine -Path $envFile -Name "AGENTPACT_JWT_TOKEN" -Value $Jwt
    }

    $cfg["mcpServers"]["agentpact"] = $proposedServerConfig

    Write-JsonFileNoBom -Path $configFile -Value $cfg
}

Write-Host ""
Write-Host "AgentPact MCP setup complete."
Write-Host "Config file: $configFile"
Write-Host "Env file:    $envFile"
Write-Host "MCP entry:   $mcpEntry"
if ($Apply) {
    Write-Host "Changes:     applied"
    if ($configBackupPath) {
        Write-Host "Config backup: $configBackupPath"
    }
    if ($envBackupPath) {
        Write-Host "Env backup:    $envBackupPath"
    }
}
else {
    Write-Host "Changes:     dry run only (no config files were modified)"
}
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
if (-not $Pk -and $Apply) {
    Write-Host ""
    Write-Host "Set AGENTPACT_AGENT_PK in the OpenClaw .env file before using AgentPact."
}
Write-Host ""
Write-Host "This repository now assumes MCP-first usage:"
Write-Host "- mcp handles the AgentPact tools"
Write-Host "- the AgentPact OpenClaw plugin provides the bundled skill, heartbeat, docs, and templates"
Write-Host ""
if ($Apply) {
    Write-Host "Restart OpenClaw to load the MCP server configuration."
}
else {
    Write-Host "Review the proposed config above. Re-run with -Apply to write changes."
}
