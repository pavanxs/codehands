# CodeHands (MCP Coding Harness)

## The Problem

Web AI assistants like ChatGPT and Claude Chat are incredibly smart — they can
reason about code, plan fixes, and write solutions. But they're trapped behind a
browser. They can't reach into your computer to actually read your files, edit
your code, or run your tests. The brain is there, but it has no hands.

Meanwhile, tools like Cursor and Codex CLI work great locally — but only from
one specific app on one specific machine. You can't use them from your phone,
from a different browser, or from ChatGPT's interface.

## The Vision

**Code from anywhere.** Open ChatGPT or Claude Chat on your phone, your tablet,
any browser, any device — type "fix the null check in `src/app.ts` line 42" —
and it happens on your development machine. The AI thinks, your machine
executes.

## What This Is

A thin MCP server that gives **web AI assistants** (ChatGPT, Claude Chat)
**step-by-step control** over your local development machine.

**The web AI is the brain. This server is just the hands.**

This server does not think. It does not make coding decisions. It does not run
an agent loop. It only routes commands and enforces safety rules.

---

## The Three Layers

```text
┌─────────────────────────────────────────────────────────┐
│  BRAIN: Web AI (ChatGPT / Claude Chat)                  │
│  Decides what to read, edit, and run. Controls step     │
│  by step. IS the agent loop.                            │
└────────────────────────┬────────────────────────────────┘
                         │ MCP tool calls
                         ▼
┌─────────────────────────────────────────────────────────┐
│  ROUTER: CodeHands (this MCP server, TypeScript)        │
│  Receives each tool call. Checks policy (is this        │
│  workspace approved?). Forwards to exec-server.         │
│  Returns results. Logs activity.                        │
│  Never makes coding decisions.                          │
└────────────────────────┬────────────────────────────────┘
                         │ JSON-RPC
                         ▼
┌─────────────────────────────────────────────────────────┐
│  EXECUTOR: Codex exec-server (lean Rust process)        │
│  Actually reads/writes files, runs terminal commands,   │
│  manages sandboxing and safety. All the hard low-level  │
│  work. Already built, open-source, battle-tested.       │
└─────────────────────────────────────────────────────────┘
```

The web AI says "read this file" → this server checks policy → Codex reads
the file → result flows back to the web AI. Every operation follows this path.

---

## Why Codex CLI (The Hard Reality)

To make this vision work, the server needs to actually do things on your
machine: read files safely, write files safely, run terminal commands in a
sandbox, manage Git, validate paths. Building all of that from scratch is a
massive amount of work — sandboxing alone is months of effort.

OpenAI already solved this problem. Their Codex CLI is open-source
(Apache 2.0), lightweight, Rust-based, ranked #1 on Terminal-Bench. It handles
file I/O, terminal execution, sandboxing, Git, and safety — all battle-tested.

So instead of rebuilding the wheel, we use their wheel. We clone Codex CLI
into our project and talk to it through its public interface. Our code never
goes inside it. **We never touch Codex's code. Ever.**

---

## The Codex Boundary (Critical Rule)

**`vendor/codex/` is a clone of the OpenAI Codex repository. It is never
modified. No harness code goes inside it. No patches, no edits, no exceptions.**

All our code lives OUTSIDE that folder. The entire harness is built around
Codex, not inside it.

**Why this matters:** OpenAI actively updates Codex CLI on GitHub. When they
release improvements — better sandboxing, new features, performance fixes — we
want those updates instantly. Because we never touched their code, upgrading is
one command:

```text
git submodule update --remote vendor/codex
```

No merge conflicts. No broken patches. No "our edit conflicts with their edit."
The folder just gets replaced with the latest version and everything keeps
working because our code only talks to Codex through its public interface,
never by reaching into its internals.

---

## Access Modes

| Mode | How | Latency | Use case |
| --- | --- | --- | --- |
| Local (HTTP) | CodeHands runs on localhost, clients connect via HTTP | ~1-3ms | Same machine, multiple chats |
| Local (stdio) | Client spawns CodeHands as subprocess (adapter) | ~0.1ms | Single client (Claude Desktop) |
| Hosted (tunnel) | Any tunnel exposes CodeHands' HTTP port publicly | ~50-200ms | Control from anywhere — phone, browser, any device |

The HTTP server is the core. The stdio adapter wraps it for clients that only
support stdio. Design is tunnel-agnostic. Server listens on a port; you pick
the tunnel. Default recommendation: Tailscale with Funnel (free, private, no
domain).

---

## Target Providers

Both **ChatGPT** and **Claude Chat** are primary targets.

---

## Tech Decisions

- **Language:** TypeScript (MCP SDK is TS-first, fast iteration)
- **Communication:** Codex exec-server via JSON-RPC (granular operations)
- **Transport:** HTTP core + stdio adapter (Option C). HTTP handles multi-client
  and hosted mode. Thin stdio adapter supports clients like Claude Desktop.
- **MCP tools:** 16 tools mirroring exec-server ops (underscore naming for MCP
  compatibility: `fs_readFile`, `process_start`, etc.) + `workspace_list`,
  `workspace_set`.
- **UI:** None. JSON config file for workspace management.
- **Config location:** `~/.codehands/config.json`
- **Multi-workspace:** One shared exec-server. CodeHands validates paths against
  approved workspaces before forwarding.
- **Concurrency:** One CodeHands instance serves multiple AI chats on multiple
  projects simultaneously.
- **Tunnel:** Tunnel-agnostic. Recommend Tailscale Funnel for hosted mode.
- **Security:** Blocked commands list + workspace validation + exec-server sandbox
- **Error recovery:** Auto-restart exec-server up to 3 times, notify connected AIs.
- **API key:** None. Exec-server is purely local — no cloud calls.
- **Distribution:** GitHub clone + `npm link`. Global `codehands` command.
  Updates via `git pull`.
- **Name:** CodeHands

## Setup Guide

### Prerequisites

- Node.js 22+ installed
- Git installed
- pnpm installed (`npm install -g pnpm`)

### Installation (one-time)

```bash
git clone https://github.com/YOUR_USERNAME/codehands.git
cd codehands
npm install -g @openai/codex
pnpm install
pnpm run build
cd apps/local-agent && npm link && cd ../..
codehands init
```

After this, `codehands` is available as a global command from anywhere.
Edit `~/.codehands/config.json` to add your project paths.

### Running (every time)

```bash
codehands start
```

That's it. CodeHands starts the HTTP server and spawns the exec-server
automatically. AI clients can connect immediately.

### First-time config

On first run, CodeHands creates `~/.codehands/config.json` if it doesn't
exist. Open it in your editor and add your project folders:

```json
{
  "workspaces": [
    "C:/Users/you/projects/my-app",
    "C:/Users/you/projects/another-project"
  ],
  "blockedCommands": [
    "rm -rf /",
    "format C:"
  ]
}
```

### Updating

```bash
cd codehands
git pull
pnpm install
```

The `codehands` command automatically points to the updated code (npm link
is a symlink).

### Updating Codex (when OpenAI releases improvements)

```bash
cd codehands
git submodule update --remote vendor/codex
```

---

## Current Status

**Working.** All 16 MCP tools implemented and tested end-to-end.

```
codehands start   → Starts server + exec-server on port 3100
codehands stdio   → stdio mode for Claude Desktop
codehands init    → Creates default config
```

See `docs/client-setup.md` for connecting ChatGPT or Claude.

When updating the ChatGPT development plugin, use the exact
[`ChatGPT Plugin Update Runbook`](docs/chatgpt-plugin-update-runbook.md). It
covers rebuilding, restarting, **Manage → Refresh**, fresh-chat verification,
and the last-resort uninstall/reinstall procedure.

---

## Key Design Rules

1. **The web AI controls everything step by step.** This server never runs an
   autonomous agent loop.
2. **Codex is used as-is.** Never modify its source. Upgrade by moving the
   submodule pointer.
3. **All operations go through Codex.** Don't rebuild what Codex already does.
4. **MCP tools are granular.** Read file, edit file, run command — not "fix my
   app."
5. **Provider-neutral.** Tool schemas work identically for ChatGPT and Claude.
6. **Lightweight.** Minimal RAM usage, lean process. No bloat.
7. **No standalone UI.** This is a headless server. No dashboards, Electron
   apps, or separate windows; the inline MCP Apps activity component only
   exposes tool-call status inside the host conversation.
8. **Low latency.** Responses must be near-instant. This is why local-first
   matters.
9. **Simple UX.** Easy to set up, easy to use. Avoid complexity wherever
   possible.
