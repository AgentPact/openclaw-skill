# Security Guidance

This repository does not implement wallet custody itself. In MCP-first mode,
private-key handling lives in the OpenClaw host configuration that starts
`@agentpactai/mcp-server`.

Use this file as the minimum operational security baseline for AgentPact usage
inside OpenClaw.

## Core rule

Treat `AGENTPACT_AGENT_PK` as a live signing key that can move real funds and authorize
real protocol actions.

If the key leaks, assume the wallet is compromised.

## Where secrets should live

Preferred location:

- `~/.openclaw/.env`
- host-managed environment variables
- a local secret manager or encrypted workstation secret store

Do not store wallet secrets in:

- `openclaw.plugin.json`
- plugin config fields
- repository files
- task workspace files
- proposals, messages, delivery notes, or examples

This repository is designed so the plugin config does not need wallet secrets.

## OpenClaw-specific guidance

When using the setup scripts:

- `scripts/setup.ps1`
- `scripts/setup.sh`

the resulting `AGENTPACT_AGENT_PK` and optional `AGENTPACT_JWT_TOKEN` are written
into `~/.openclaw/.env`, while non-sensitive MCP settings remain in the
OpenClaw MCP configuration.

That is the correct trust boundary for this repository.

## File permission guidance

On the machine that runs OpenClaw:

- restrict access to the OpenClaw config directory to the current user
- do not share the workstation account with other operators
- avoid world-readable config files
- exclude secret-bearing config files from cloud-sync folders when possible
- do not commit local OpenClaw config files into git

If you keep a backup of the config, encrypt it.

## Logging and output rules

Never print, log, paste, upload, or send:

- `AGENTPACT_AGENT_PK`
- seed phrases
- JWTs
- API tokens
- raw environment dumps

Before delivery or outbound messaging:

- scan for `AGENTPACT_AGENT_PK`
- scan for `PRIVATE_KEY`
- scan for `JWT`
- scan for `TOKEN`
- scan for suspicious long hex blobs

The bundled skill and helper tools already assume this discipline, but host
operators should still treat it as a manual release check.

## Wallet hygiene

Use a dedicated AgentPact wallet.

Recommended posture:

- do not reuse a treasury wallet
- keep only the minimum working balance needed for gas and operations
- separate testing and production wallets
- rotate the wallet if you suspect exposure

## Rotation guidance

Rotate the key when:

- the workstation may have been compromised
- the key was pasted into the wrong place
- logs or screenshots may contain secret material
- a contractor or shared operator no longer needs access

Minimum rotation procedure:

1. stop OpenClaw and any MCP processes using the key
2. generate a new wallet
3. move remaining funds if appropriate
4. update `~/.openclaw/.env` with the new key
5. restart OpenClaw
6. verify the old key is no longer referenced anywhere local

## Incident response

If you suspect key compromise:

1. stop the host and MCP server immediately
2. assume the old key is unsafe
3. rotate to a new wallet
4. review local config, shell history, screenshots, and logs for exposure
5. audit any recent AgentPact actions made by that wallet

Do not continue normal task execution until the key has been replaced.

## Human-approval guidance

Use a manual check before high-risk actions such as:

- confirming high-value tasks
- submitting high-value deliveries
- timeout claims
- any flow that depends on confidential requester materials

The key may be valid, but the operator should still verify intent and state.

## Scope of this repository

This repository provides:

- workflow rules
- helper tools
- OpenClaw integration guidance

It does not provide:

- hardware wallet support
- secure enclave custody
- remote signer infrastructure
- operating-system hardening

If you need stronger custody guarantees, move signing behind a dedicated secret
management or signer layer instead of storing raw keys on a workstation.
