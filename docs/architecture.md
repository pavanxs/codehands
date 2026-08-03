# Architecture

This document describes the stable system boundary. Active tool contracts, implementation priorities, and open decisions are authoritative in [`CURRENT_PLAN.md`](./CURRENT_PLAN.md).

## Product boundary

CodeHands is a thin, policy-controlled MCP bridge that gives AI clients step-by-step access to a development machine.

```text
AI client
  -> MCP tool call
CodeHands
  -> validation, policy, schemas, audit, result formatting
Codex exec-server
  -> filesystem, process, and HTTP execution
Local machine
```

The AI client controls the agent loop. CodeHands does not independently plan or chain coding work.

## Component responsibilities

| Component | Responsibility |
| --- | --- |
| `apps/local-agent` | Hosts the MCP server, manages the Codex adapter, exposes tools, and maintains the current global workspace/process view. |
| `packages/mcp-tools` | Defines public tool names, input schemas, output schemas, handlers, result envelopes, and continuation fields. |
| `packages/codex-adapter` | Speaks Codex exec-server JSON-RPC and maps CodeHands requests to Codex protocol operations. |
| `native/codehands-apply-patch` | CodeHands-owned JSON helper that links Codex's maintained patch and filesystem crates, performs full preflight/confinement, and reports structured committed deltas. |
| `packages/policy-engine` | Resolves and validates workspace paths and applies command policy. |
| `packages/audit` | Records redacted parameters, exact call start/completion timing, and bounded status/duration summaries for aggregate execution tools. |
| `vendor/codex` | Unmodified upstream Codex source and protocol implementation. |

## Transport

Streamable HTTP is the primary shared transport. Stdio is available for local clients that require it. Both transports expose the same tool implementation.

The transport model is not being redesigned in the current version. Current work is limited to lifecycle correctness, deterministic tool definitions, schemas, and diagnostics.

## Global workspace and process model

The current version intentionally uses a global model for one trusted owner and that owner's agents:

- One active workspace is shared across connected agents.
- A fresh server selects the first configured workspace automatically when the prior process-global selection is absent or no longer approved.
- The process registry is global.
- Every connected agent can access every configured repository.
- Every connected agent can list, read, write to, signal, or terminate every CodeHands-managed process.
- Processes do not belong to a session, connector, user, or workspace.

Per-user state, process ownership, permissions, and isolation are deferred to a possible multi-user version 3.

## Operation flow

1. The client invokes a CodeHands MCP tool.
2. CodeHands validates the request and resolves paths or command launch details.
3. CodeHands applies workspace and command policy.
4. For routine operations, the Codex adapter invokes the corresponding exec-server JSON-RPC operation. For `fs_applyPatch`, CodeHands launches the native helper through Codex process primitives after resolving the active workspace.
5. Codex exec-server or the Codex-linked patch helper performs the local operation.
6. CodeHands returns the authoritative structured result and backward-compatible JSON text; `view_image` additionally returns MCP image content and `request_user_input` may issue a nested MCP elicitation request.

## Upstream boundary

`vendor/codex/` must not be modified. CodeHands primarily follows Codex exec-server contracts and adapts them at the public MCP boundary, such as exposing directly reusable continuation positions or homogeneous one-to-eight request arrays. The patch helper is built outside `vendor/codex/`, uses a pinned lockfile, and links the maintained `codex-apply-patch` crate rather than copying its parser or invoking Codex's hidden apply-patch dispatch path.
