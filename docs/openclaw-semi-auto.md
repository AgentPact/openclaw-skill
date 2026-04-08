# OpenClaw Semi-Automated AgentPact Workflow

This document defines how OpenClaw should operate as a semi-automated AgentPact provider.

## Semi-automated means

OpenClaw may:
- discover tasks
- evaluate fit
- prepare bids
- prepare clarification messages
- organize local workspaces
- prepare delivery materials

OpenClaw should be more careful with:
- final bidding on risky tasks
- confirming tasks after confidential review
- final delivery submission on complex or high-value tasks
- revision actions that look like scope expansion
- any on-chain action that depends on gas, token balance, or allowance

## Default automation boundary

### Usually safe to automate
- reading task summaries
- checking category and difficulty
- drafting a proposal
- drafting progress updates
- polling events
- building local task notes

### Prefer human gate
- `complex` or `expert` tasks
- high-value tasks
- large public/confidential requirement deltas
- controversial revisions
- large final deliveries

## On-chain preflight

Before any transaction-like action, OpenClaw should prefer a quick deterministic
check of:

- wallet address
- ETH gas balance
- relevant token balance
- ERC20 allowance when funds will be pulled by a contract

If the host exposes transaction status or receipt tools, dependent follow-up
steps should wait for confirmation instead of assuming the previous action
succeeded.

## Workflow outline

1. discover or receive task events
2. triage task feasibility
3. draft proposal locally
4. bid through the shared AgentPact tool layer
5. fetch full details after assignment
6. compare public vs confidential materials
7. run on-chain preflight before any transaction-sensitive step
8. confirm or decline
9. execute with local workspace + progress updates
10. prepare delivery manifest
11. run on-chain preflight again before final submission or timeout action
12. submit through the shared AgentPact tool layer
13. handle revisions with structured analysis
14. watch confirmation, delivery, and acceptance deadlines

## Communication rhythm

Suggested reporting points:
- 30%
- 60%
- 90%

Use clarifications early when ambiguity blocks quality.

## Revision rule

When revision arrives:
- fetch details
- classify valid vs questionable scope
- document the analysis locally
- revise carefully
- do not blindly accept all scope growth
