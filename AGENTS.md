# AGENTS.md — Rules for AI Agents Working on This Project

Read this first before writing any code.

---

## Why This Project Exists (The Story)

Web AI assistants (ChatGPT, Claude Chat) are incredibly smart. They can reason
about code, plan multi-step fixes, and write entire features. But they're
trapped behind a browser — they cannot reach into your computer to read files,
edit code, or run commands. The brain exists, but it has no hands.

Meanwhile, tools like Codex CLI are great at executing on a local machine — but
they only work from one specific app on one specific device.

**This project bridges the gap.** It lets you open ChatGPT or Claude Chat on
ANY device — phone, tablet, browser, anywhere — type "fix the bug on line 42"
and have it actually happen on your development machine. The web AI thinks.
Your machine executes.

---

## Why We Use Codex CLI (And Never Modify It)

To make this work, something needs to safely read files, write files, run
terminal commands, manage Git, and sandbox everything on your machine. Building
all of that from scratch is months of work — sandboxing alone is a huge effort.

OpenAI already built it. Their Codex CLI is open-source, battle-tested, and
handles all the hard low-level execution. Instead of rebuilding what they
built, we clone their repository into `vendor/codex/` and USE it as-is.

**We never touch their code** because OpenAI actively updates Codex. When they
ship improvements (better sandboxing, new features, performance), we want those
updates instantly. Since we never modified their code, upgrading is one
command with zero merge conflicts. If we had edited their files, every upgrade
would be a painful merge battle.

All our code lives OUTSIDE their folder. We only talk to Codex through the
exec-server's JSON-RPC interface — like calling a phone number instead of
breaking into someone's house.

---

## What This Project Is

**CodeHands** is a thin MCP server (TypeScript). It lets web AI assistants
(ChatGPT, Claude Chat) control a local development machine step by step.

**Three layers:**

1. **Brain:** The web AI (ChatGPT / Claude Chat). It decides everything — what
   to read, edit, and run. It IS the agent loop.
2. **Router:** CodeHands (this MCP server, TypeScript). It receives tool calls,
   enforces workspace policy, and forwards requests to the exec-server via
   JSON-RPC. It never makes coding decisions.
3. **Executor:** Codex exec-server (lean Rust background process). It actually
   reads/writes files, runs commands, and handles sandboxing.

The web AI sends individual tool calls: read file, edit file, run command. This
server routes each one to the exec-server and returns the result. That's it.

---

## The #1 Rule: NEVER Touch Codex Code

`vendor/codex/` is a Git submodule clone of https://github.com/openai/codex.

**It must NEVER be modified. No exceptions.**

- Do NOT add files inside `vendor/codex/`.
- Do NOT edit files inside `vendor/codex/`.
- Do NOT patch, fork, or override anything in that folder.
- Do NOT import Codex internals or private modules.

All harness code lives OUTSIDE `vendor/codex/`. The harness talks to Codex
ONLY through the exec-server's JSON-RPC interface.

**Why:** OpenAI updates Codex frequently. By keeping it untouched, upgrading is
just `git submodule update --remote vendor/codex` — zero merge conflicts, zero
broken patches. If you modify Codex source, upgrades become impossible.

---

## Documentation Source of Truth

Before planning or implementing a contract change, read `docs/CURRENT_PLAN.md`. It is the single authoritative source for accepted design decisions, target tool contracts, deferred work, and open questions.

- Update `docs/CURRENT_PLAN.md` when a decision changes.
- Do not create a separate `priorities/` design tree or another competing plan.
- Keep setup, architecture, and threat-model documents focused; link to the current plan instead of duplicating evolving contracts.
- Runtime source describes implemented behavior; `docs/CURRENT_PLAN.md` describes the agreed target until implementation catches up.

---

## Architecture Rules

1. **This server does NOT run an agent loop.** The web AI controls step by step.
   Never add autonomous decision-making to this server.

2. **All file/terminal operations go through Codex.** Do not reimplement file
   reading, file writing, terminal execution, or Git operations yourself. Codex
   already handles these.

3. **The harness only adds:** MCP tool exposure, workspace policy enforcement,
   audit logging, and relay transport. It does NOT add coding intelligence.

4. **Tools are granular.** Each MCP tool does one atomic thing (read a file,
   run a command). Never build a tool that does multiple steps autonomously.

5. **Provider-neutral.** Tool schemas must work identically for ChatGPT and
   Claude Chat. No provider-specific logic in core code.

6. **Lightweight.** Minimal RAM usage, lean process. No bloat, no heavy
   frameworks, no unnecessary dependencies. If something can be done simply,
   do it simply.

7. **No UI.** This is a headless server process. Do not build dashboards,
   configuration GUIs, or visual interfaces. Users already have editors.

8. **Low latency.** Every tool call must respond near-instantly. Avoid
   unnecessary overhead, extra process spawns, or slow abstractions.

9. **Simple UX.** Setup and usage must be straightforward. Avoid complexity
   wherever possible.

---

## Project Structure

```
mcp-coding-harness/
├── apps/
│   ├── local-agent/       ← Main MCP server process (TypeScript)
│   └── mcp-gateway/       ← Future hosted endpoint
├── packages/
│   ├── codex-adapter/     ← JSON-RPC client for exec-server
│   ├── policy-engine/     ← Workspace allowlists, path validation
│   ├── mcp-tools/         ← MCP tool schemas mirroring exec-server ops
│   ├── protocol/          ← Shared types and schemas
│   ├── audit/             ← Event logs
│   ├── relay-client/      ← Future remote access
│   └── shared/            ← Common utilities
├── vendor/
│   └── codex/             ← UNTOUCHED Git submodule. Never modify.
├── configs/               ← Workspace config (JSON), never credentials
├── docs/                  ← Architecture decisions
├── scripts/               ← Bootstrap and update scripts
└── tests/                 ← Unit, integration, contract, e2e
```

---

## Tech Stack

- TypeScript (ES2022, NodeNext modules)
- pnpm monorepo
- Node.js 22+
- Codex communication: exec-server via JSON-RPC
- Transport: HTTP core (Streamable HTTP) + thin stdio adapter
- MCP tools: mirror exec-server operations (passthrough)
- Config: `~/.codehands/config.json` (workspace approvals, blocked commands)
- Multi-workspace: one shared exec-server, CodeHands validates paths
- Concurrency: one instance serves multiple AI chats simultaneously
- Error recovery: auto-restart exec-server up to 3 times, notify connected AIs
- Distribution: GitHub clone + npm link (global `codehands` command, git pull to update)
- API key: none needed (exec-server is purely local)
- UI: none (headless server)

---

## When Adding New Code

- Put it in the appropriate `packages/` or `apps/` directory.
- Never put it in `vendor/codex/`.
- Follow the existing TypeScript config (`tsconfig.base.json`).
- Keep tools atomic and provider-neutral.
