# CodeHands setup tutorial

This guide configures a local, sandboxed CodeHands server. It intentionally
does not publish the MCP endpoint to the internet.

## 1. Install prerequisites

- Node.js 22
- Git
- pnpm 10.10 through Corepack
- Rust through <https://rustup.rs/> to build the pinned executor

Windows users should run these commands in PowerShell. macOS and Linux users
can use their normal terminal.

## 2. Clone the correct repository

```bash
git clone --recurse-submodules https://github.com/pavanxs/codehands.git
cd codehands
corepack enable
pnpm install --frozen-lockfile
```

If the repository was cloned without submodules:

```bash
git submodule update --init vendor/codex
```

Do not use `git submodule update --remote`; the recorded commit is the tested
protocol version.

## 3. Build CodeHands and its pinned Codex executor

```bash
pnpm build
pnpm test
pnpm codex:check
pnpm codex:build
```

The last command prints a path ending in:

- `vendor/codex/codex-rs/target/release/codex` on macOS/Linux
- `vendor\codex\codex-rs\target\release\codex.exe` on Windows

## 4. Install the local command

```bash
cd apps/local-agent
npm link
cd ../..
codehands init
```

## 5. Configure one or more workspaces

Open `~/.codehands/config.json`. Add exact project paths and the absolute
`codexBinary` path printed by the build:

```json
{
  "workspaces": [
    "C:/Users/you/projects/my-app"
  ],
  "codexBinary": "C:/path/to/codehands/vendor/codex/codex-rs/target/release/codex.exe"
}
```

Keep authentication enabled. Keep `host` set to `127.0.0.1`. Keep outbound
HTTP disabled unless a specific use case requires a narrow allowlist.

## 6. Verify and start

```bash
codehands doctor
codehands start
```

`doctor` checks:

- configured workspace existence;
- bearer-token availability;
- exec-server startup and protocol compatibility;
- real platform sandbox enforcement.

The server refuses to start with a configured workspace when sandbox
enforcement cannot be proved.

## 7. Connect a local client

Use stdio when supported:

```json
{
  "mcpServers": {
    "codehands": {
      "command": "codehands",
      "args": ["stdio"]
    }
  }
}
```

For a local HTTP client, configure `http://127.0.0.1:3100/mcp` and supply the
bearer token stored in `~/.codehands/http-token`.

## 8. Use it efficiently

The client should begin with `workspace_list` and `workspace_set`. A normal
request can then say simply: “Use CodeHands to make this change and verify the
Git diff.” No unusual path preamble is needed.

Fast, conflict-safe tools are available for:

- line-range reads;
- text search;
- exact replacement;
- unified patches;
- Git status and diff;
- recent sanitized activity.

Commands must use separate argv:

```json
{
  "command": "npm",
  "args": ["test"]
}
```

## Troubleshooting

- Run `codehands doctor`.
- Use `codehands logs -f` to watch sanitized calls and durations.
- Ask the client to call `activity_recent`.
- If sandbox verification fails, rebuild the pinned submodule and confirm that
  `codexBinary` points to that build rather than an unrelated global Codex.
- If authentication fails, confirm the client reads
  `~/.codehands/http-token`; never paste the token into a chat.
- If a workspace is ambiguous, use the exact path returned by
  `workspace_list`.

For remote web clients, read [hosted-gateway.md](hosted-gateway.md). Do not
substitute a public tunnel for OAuth.
