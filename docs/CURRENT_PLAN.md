# CodeHands Current Design and Implementation Plan

## Status and documentation governance

This is the single authoritative source for current CodeHands design decisions, implemented tool contracts, validation status, and deferred work.

**Implementation status (August 3, 2026):** the source tree implements 24 public tool definitions. Clients without MCP form elicitation receive 23 tools because `request_user_input` is capability-gated; clients advertising `elicitation.form` receive all 24. The TypeScript monorepo build, native patch-helper release build, 102 automated tests, seven native patch safety checks, real Codex-backed correctness smoke, 50-check existing HTTP integration suite, 15-check new-tool HTTP suite, and six-check live HTTP elicitation suite all pass on Windows. The active port-3100 server and installed client snapshot still require restart/refresh before they expose the new surface.

Other repository documents have narrower purposes:

- `README.md` is the user-facing product and setup overview.
- `docs/architecture.md` describes stable system boundaries and component responsibilities.
- `docs/threat-model.md` records stable trust assumptions.
- Tutorials and provider guides describe setup and currently available behavior.
- Runtime source files describe what is implemented today.

Those files must link here rather than duplicate evolving contracts. When another document conflicts with this one about the target design, this document wins.

## Core boundary

CodeHands is a thin MCP bridge over Codex exec-server:

```text
AI client -> CodeHands MCP server -> Codex exec-server -> local machine
```

CodeHands owns MCP exposure, input and output schemas, workspace validation, command policy, audit records, launch normalization, continuation adaptation, and result formatting. Codex performs filesystem, process, and HTTP execution.

Rules:

- The AI client controls the agent loop. CodeHands does not autonomously plan or chain coding work.
- Routine filesystem, process, and HTTP execution continues through the running Codex exec-server. `fs_applyPatch` is the explicit exception: CodeHands launches a native helper through Codex process primitives, and that helper links Codex's maintained `codex-apply-patch` and exec-server filesystem crates.
- Reuse the existing launch resolver and policy path instead of creating a second command-launch implementation.
- `vendor/codex/` remains untouched. Do not patch, edit, or add files inside it.
- Do not use experimental MCP SDK v2, draft-only, prerelease, release-candidate, or speculative protocol capabilities in the current version.

## Current trust model

The current deployment assumes one trusted owner and that owner's agents.

- The active workspace is global and shared by all connected agents.
- On server startup, the first configured workspace becomes active when no valid process-global selection exists; this removes any requirement for one connector to initialize another.
- The process registry is global and visible to all connected agents.
- Any connected agent may select and access any configured repository.
- Any connected agent may list, read, write to, signal, or terminate any CodeHands-managed process.
- Processes are not owned by a session, connector, user, or workspace.
- Do not add per-agent identity, permissions, process ownership, isolation, or approval workflows in the current version.
- Keep low-friction safeguards that do not change normal trusted-owner usage.

Authentication, authorization, remote-access policy, and multi-user isolation are deferred to a possible version 3 and are not near-term implementation requirements.

## Public tool surface

The implemented definition surface contains 24 tools. Existing tools keep their existing names; accepting multiple requests does not rename a tool. `request_user_input` is listed only for clients that advertise MCP form elicitation, so unsupported sessions receive 23 tools.

- `workspace_list`
- `workspace_set`
- `fs_readFile`
- `fs_writeFile`
- `fs_createDirectory`
- `fs_readDirectory`
- `fs_walk`
- `fs_remove`
- `fs_copy`
- `fs_getMetadata`
- `repo_query`
- `fs_applyPatch`
- `view_image`
- `process_run` — bounded command helper
- `process_start`
- `process_read`
- `process_write`
- `process_signal`
- `process_terminate`
- `process_list`
- `http_request`
- `wait`
- `batch`
- `request_user_input` — capability-gated by `elicitation.form`

Decisions:

- Do not rename `fs_readFile` or `fs_writeFile` to plural names.
- Do not merge `process_signal` and `process_terminate` into a combined control tool.
- Keep the public `batch` tool supported; it is not scheduled for removal.
- The CodeHands `batch` tool is a normal heterogeneous tool. It is distinct from protocol-level JSON-RPC batching.
- Do not depend on protocol-level JSON-RPC batching in the current design.

## Shared one-to-eight request contract

The following tools accept a homogeneous `requests` array containing one to eight items:

- `fs_readFile`
- `fs_writeFile`
- `fs_createDirectory`
- `fs_readDirectory`
- `fs_walk`
- `fs_remove`
- `fs_copy`
- `fs_getMetadata`
- `process_run`
- `process_start`
- `process_read`
- `process_write`
- `process_signal`
- `process_terminate`
- `http_request`

Rules:

- `requests` is an array with `minItems: 1` and `maxItems: 8`.
- There is no caller-defined per-item `id`.
- Return exactly one result per request.
- Results remain in request order even when execution is concurrent.
- Identify items using natural operation fields such as `path`, `sourcePath`, `destinationPath`, `command`, `args`, or `processId`.
- Each result includes `success`.
- A failed item includes a normalized error object:

```json
{
  "code": "MACHINE_READABLE_CODE",
  "message": "Concise human-readable explanation"
}
```

- One item failing does not fail unrelated items.
- Read-only filesystem operations, including `fs_walk`, may execute concurrently, bounded by the maximum of eight requests.
- File writes, directory creation, copies, removals, `process_start`, `process_write`, signals, terminations, and `http_request` execute sequentially in request order.
- `http_request` is sequential because HTTP methods may have external side effects; no separate HTTP parallel-execution mode is added in the current version.
- `process_run` executes sequentially by default and may use explicit parallel execution capped at three commands.
- Changed tools accept only the new `requests[]` contract. The old singular input form is rejected rather than normalized for compatibility.
- A call is invalid when `requests` is missing, is not an array, is empty, or contains more than eight items.

`repo_query`, `fs_applyPatch`, `view_image`, `request_user_input`, `process_list`, workspace tools, `wait`, and `batch` are singular tools and do not use the shared `requests[]` envelope.

## Workspace-relative paths

For filesystem operations and command working directories:

- Relative paths resolve against the current global active workspace.
- `"."` means the active workspace root.
- Existing canonical real-path and nearest-existing-parent validation remains in force.
- Symlink or junction escapes outside configured workspaces remain rejected.
- Multi-item support does not weaken workspace validation.

## Output windows

Output limits are per-response windows, not permanent total-content limits. A caller must be able to continue until file EOF or until Codex-retained process output is exhausted.

Use named shared constants rather than scattered literals. Initial current-version values are:

- Line-oriented file read: 20,000 characters per item
- Byte-oriented file read: 20,000 bytes per item
- `process_run` stdout: 20,000 characters per item
- `process_run` stderr: 10,000 characters per item
- Total tool-response window: 60,000 characters

These are initial implementation defaults, not benchmark claims. Tuning and broad performance benchmarking are deferred to version 3.

The server must not silently discard retrievable content. Truncated results return explicit truncation and directly reusable continuation fields.

## `process_run`

Use `process_run` for commands expected to complete within a bounded timeout in one MCP call. Use `process_start` for servers, watchers, interactive programs, and longer-running work.

### Input

```json
{
  "requests": [
    {
      "command": "git",
      "args": ["status", "--short"],
      "shell": false,
      "cwd": ".",
      "timeoutMs": 30000,
      "maxStdoutChars": 20000,
      "maxStderrChars": 10000
    }
  ],
  "execution": "sequential"
}
```

Execution rules:

- Accept one to eight command requests.
- Use the same direct-versus-shell launch contract and launch resolver as `process_start`.
- Direct execution preserves exact executable and argument boundaries.
- Shell execution is explicit.
- `args` is invalid when `shell` is `true`.
- Resolve `cwd` against the current global workspace; `"."` means workspace root.
- Apply the existing blocked-command policy to the resolved launch plan.
- Sequential execution is the default.
- Optional `execution: "parallel"` is allowed.
- `maxConcurrency` is capped at three.
- Each command is managed by Codex as an independent logical process.
- Collect every item result and preserve input order.

### Timeout contract

- Default: `30000` milliseconds
- Minimum accepted positive value: `100` milliseconds
- Maximum: `60000` milliseconds
- Reject a value above `60000` before process launch.
- Timeout uses Codex `process/terminate`, not graceful interrupt.

Validation message for a value above the maximum:

```text
process_run is intended for short commands and supports at most 60000 ms. Use process_start for longer-running commands, servers, watchers, or interactive work.
```

### Exact result fields

Every item repeats the natural command fields and returns:

- `command`
- `args`
- `shell`
- `cwd`
- `status`: `succeeded`, `failed`, or `timed_out`
- `success`
- `exitCode`
- `timedOut`
- `durationMs`
- `stdout`
- `stderr`
- `stdoutTruncated`
- `stderrTruncated`
- optional `error`
- optional `processId` and directly reusable `nextAfterSeq` only when continuation is available

Semantics:

- `success: true` only when the command exits with code `0`.
- A non-zero exit is `status: "failed"`, `success: false`, and the actual numeric `exitCode`.
- A non-zero exit does not fail the whole tool call and does not stop unrelated requests.
- A timeout is `status: "timed_out"`, `success: false`, `timedOut: true`, and `exitCode: null`.
- Timeout error code: `PROCESS_RUN_TIMEOUT`.
- Timeout message:

```text
Command exceeded the {timeoutMs} ms process_run timeout and was terminated. Use process_start for long-running work.
```

- Keep stdout and stderr separate.
- When all output fits, omit `processId` and `nextAfterSeq`.
- When output is truncated and Codex-retained output remains, include `processId` and `nextAfterSeq` so the caller can continue with `process_read`.

## Process output and continuation

Codex process output is sequenced across stdout, stderr, PTY output, and lifecycle events.

- Codex `process/read` accepts `afterSeq`, `maxBytes`, and `waitMs`.
- Codex returns `nextSeq`.
- Native continuation requires the next `afterSeq` to be `nextSeq - 1`.
- CodeHands exposes a directly reusable `nextAfterSeq`, hiding that subtraction.

CodeHands does not create a second output store, consumed-output deletion mechanism, or retention timer. Codex remains the source of truth:

- Up to 1 MiB of retained output per process
- Up to 50,000 retained chunks per process
- Closed process output remains readable for approximately 30 seconds after all output streams close
- Codex then removes the closed process automatically
- Reading output does not delete it early

Commands expected to produce very large output should use `process_start` plus repeated `process_read`, not `process_run`.

### Multi-process `process_read`

`process_read` accepts one to eight independent requests:

```json
{
  "requests": [
    {
      "processId": "proc-1",
      "afterSeq": 0,
      "maxBytes": 20000,
      "waitMs": 1000
    },
    {
      "processId": "proc-2",
      "afterSeq": 7,
      "maxBytes": 20000,
      "waitMs": 0
    }
  ]
}
```

Rules:

- Each item has its own `afterSeq`, `maxBytes`, and `waitMs`.
- Independent Codex reads execute concurrently with all-settled behavior.
- The overall call waits approximately for the slowest item, not the sum of waits.
- Results remain in input order.
- One missing or failed process affects only its own result.
- Every successful result repeats `processId` and returns its own lifecycle fields and directly reusable `nextAfterSeq`.
- Do not add a global `waitMs`, shared cursor, or separate process-output store.

### `process_read` output shape (decided)

Preserve Codex output ordering and stream identity while decoding its base64 byte chunks to UTF-8 text. Return ordered text chunks only:

```json
{
  "processId": "proc-1",
  "success": true,
  "chunks": [
    { "seq": 4, "stream": "stdout", "text": "building...\n" },
    { "seq": 5, "stream": "stderr", "text": "warning...\n" }
  ],
  "nextAfterSeq": 5,
  "exited": false,
  "exitCode": null,
  "closed": false,
  "failure": null,
  "sandboxDenied": false
}
```

Rules:

- Each chunk contains `seq`, `stream`, and decoded UTF-8 `text`.
- `stream` is `stdout`, `stderr`, or `pty`, matching Codex.
- Preserve Codex chunk order exactly.
- Do not expose Codex base64 `chunk` values publicly.
- Do not add an aggregated `output`, `stdout`, or `stderr` field to `process_read`; that would duplicate content or lose cross-stream ordering.
- `process_run` continues returning aggregated final `stdout` and `stderr` because it is a bounded completion helper with a different purpose.
- Return `nextAfterSeq` as the directly reusable continuation position derived from Codex `nextSeq`.
- Return lifecycle fields `exited`, `exitCode`, `closed`, `failure`, and `sandboxDenied`.

## Filesystem operations

### `fs_readFile`

`fs_readFile` accepts one to eight requests and supports line and byte continuation modes.

Line mode:

```json
{
  "requests": [
    {
      "path": "src/server.ts",
      "fromLine": 100,
      "toLine": 260,
      "maxChars": 20000
    }
  ]
}
```

Line behavior:

- Omitting `fromLine` and `toLine` reads from the beginning, subject to the response window.
- Supplying only `fromLine` reads forward from that line.
- Supplying only `toLine` reads from line 1 through that line.
- A partial result returns `nextFromLine` and `eof`.
- The next request may pass `nextFromLine` back unchanged as `fromLine`.

Byte mode:

```json
{
  "requests": [
    {
      "path": "src/server.ts",
      "offset": 0,
      "maxBytes": 20000
    }
  ]
}
```

Byte behavior:

- A partial result returns `nextOffset` and `eof`.
- The next request may pass `nextOffset` back unchanged as `offset`.

CodeHands keeps Codex file handles private and performs `fs/open`, `fs/readBlock`, and `fs/close` within each operation. Do not expose Codex handle IDs or invent opaque public cursors.

Expected result fields:

- Common: `path`, `success`, `content`, `eof`, and optional `error`
- Line mode: `fromLine`, `toLine`, optional `totalLines` when inexpensive, `returnedChars`, and optional `nextFromLine`
- Byte mode: `offset`, `returnedBytes`, and optional `nextOffset`

### Writes and state-changing filesystem operations

Multi-item writes and other state-changing filesystem operations run sequentially in request order.

Each actual file write is delegated to Codex `fs/writeFile`.

Do not add the following in the current version:

- expected hashes
- cross-file transactions
- rollback
- destination-group preflight
- atomic temporary-file replacement
- duplicate-destination special rules
- CodeHands-specific write-size limits

Earlier successful items remain successful if a later item fails.

## Process signal and termination

These remain separate because Codex exposes separate operations with different contracts and behavior:

```text
process_signal    -> Codex process/signal
process_terminate -> Codex process/terminate
```

- Codex currently supports the `interrupt` signal for `process/signal`.
- `process_signal` is a graceful interrupt request analogous to Ctrl+C or SIGINT.
- The process may perform cleanup, ignore the signal, or continue running.
- Some Windows or backend configurations may report that interrupt is unsupported; the result should direct the caller to `process_terminate` when appropriate.
- `process_terminate` forcibly stops the process session.
- `process_run` timeouts always use termination.

Both tools accept one to eight requests and execute them sequentially in input order. A failure affects only its own result.

## Structured results and output schemas

Implement both `structuredContent` and `outputSchema` for every public tool in the current version. The installed stable SDK line supports both; the currently installed resolved version is `@modelcontextprotocol/sdk` 1.30.0.

Rules:

- Every non-error result is rooted at a JSON object.
- `structuredContent` is authoritative.
- Text `content` contains the same JSON object serialized as text for backward compatibility.
- Compact or pretty JSON formatting may differ, but the text must not omit fields, summarize differently, or report different facts.
- Every public tool advertises a deterministic operation-specific `outputSchema`.
- Multi-item tools return `{ "results": [...] }`.
- One result is returned for every request in request order.
- Schemas require stable identity and status fields, such as `path` plus `success`, `processId` plus `success`, or `command` plus `success`.
- Success-only data and `error` remain optional in the first schema version.
- Do not use complicated `oneOf` success/failure branches initially.
- Do not set `additionalProperties: false` on output objects initially.
- Partial item failures are normal successful MCP calls containing `success: false` and a structured item error.
- Whole-tool validation or launch failures may return `isError: true` with readable text and no `structuredContent`.
- Use shared schema builders for common envelopes, errors, paths, process IDs, continuation fields, and ordering.
- The `batch` output schema should remain permissive for nested per-tool `data` because the nested result shape varies by invoked tool.

Implementation shape:

- Add `outputSchema` to public tool definitions and include it in `tools/list`.
- Extend the tool result type with optional `structuredContent`.
- Make the shared successful-result helper return both serialized JSON text and the same object as `structuredContent`.
- Keep schemas and runtime result construction in the MCP tools package rather than duplicating them in the HTTP server.

## MCP and transport modernization

Current-version work:

- Record the protocol version requested by the client.
- Record the protocol version negotiated by the server.
- Record client name, client version, and advertised capabilities as diagnostic metadata.
- Remain on the stable production MCP TypeScript SDK major and apply tested stable patch/minor updates.
- Keep tool order, names, descriptions, annotations, input schemas, and output schemas deterministic.
- Audit existing Streamable HTTP initialization, session validation, POST handling, GET streaming where applicable, DELETE/session termination, disconnect behavior, abandoned-transport cleanup, and exec-server restart behavior without changing the transport model.
- Use focused compatibility tests for the installed stable SDK default and the protocol version observed from the real ChatGPT connector.

Do not introduce protocol-level JSON-RPC batching. Repeated homogeneous work stays inside explicit `requests[]` tool contracts. The existing CodeHands `batch` tool remains public.

A replacement ChatGPT plugin snapshot is deferred to version 3. An already installed plugin snapshot will not automatically expose new public names, input schemas, or output schemas until that snapshot is refreshed later.

## `http_request` multi-item behavior and limits (implemented)

`http_request` accepts one to eight requests through the shared `requests[]` contract and executes them sequentially in input order.

Keep HTTP handling deliberately thin:

- Forward each request to Codex `http/request`.
- Forward an explicitly supplied `timeoutMs` unchanged.
- Codex applies that exact millisecond timeout.
- When `timeoutMs` is omitted, Codex applies no timeout.
- Do not add a second CodeHands timeout, default timeout, maximum timeout, retry policy, or cancellation layer in the current version.
- Codex buffered mode may return an arbitrarily large body, so CodeHands applies a public response-body window.
- `maxResponseBytes` is optional, defaults to 60,000 bytes, and accepts values from 1 through 60,000.
- Multi-request calls divide the shared 60,000-character response budget across their items; the effective per-item limit is the smaller of the requested limit and that shared allocation.
- Keep the current public `http_request` contract buffered; do not add a second retention system or public streaming cursor in this version.
- A truncated response remains a successful HTTP result and must explicitly report truncation.

Each successful item repeats `method` and `url`, returns the Codex response `status`, headers, and bounded decoded body, and includes `returnedBytes`, `totalBytes`, and `bodyTruncated`. Failed items return a normalized error.

## Post-PR capability decisions

The following decisions cover the non-UI capabilities reviewed from PR #9 and PR #10. Items already replaced by the current design are excluded from this roadmap.

1. **Stronger Git force-push protection** — defer to version 3 discussion. Do not change current command policy now. The future discussion should cover force refspecs, unpinned leases, and whether a full-SHA-pinned lease is safe enough to permit.
2. **ChatGPT plugin refresh and release runbook** — implement now. The canonical operational guide is `docs/CHATGPT_PLUGIN_RELEASE_RUNBOOK.md`.
3. **Separate `process_startShell` tool** — do not implement. Existing explicit `shell: true` mode is sufficient.
4. **Global `allowShell` configuration** - version 3 discussion only; no code change now. This would be one server-level switch that rejects every `shell: true` request when disabled and belongs with future hosted-deployment and permission-policy design.
5. **Command-argument path confinement** — do not implement. Keep current workspace and working-directory validation; do not guess which arbitrary command arguments are filesystem paths.
6. **Advanced process registry and restart recovery** — version 3 discussion only. Consider lightweight `stale` or `lost` diagnostics and adapter-generation metadata without committing to a second output store.
7. **Secondary process-output retention** — version 3 discussion only; worth evaluating, not approved for implementation. Discuss privacy, cleanup, storage growth, and duplication of Codex retention.
8. **Process-list filtering and pagination** — defer. Revisit only if the global process list becomes materially large or noisy.
9. **Repository viewer/context system** — implemented as `repo_query` modes `overview` and `tree`.
10. **Filesystem/repository search** — implemented as `repo_query` mode `search`, with bounded path/content matches, literal/regex behavior, path globs, ignore handling, and continuation.
11. **Patch-based editing** — implemented as `fs_applyPatch` through the CodeHands-owned native bridge around Codex's maintained patch crate, with preflight verification, confinement, dry-run, overwrite policy, CRLF preservation, and structured partial-delta reporting.
12. **Configured `test_run` tool** — do not implement for the current trusted local product. Use `process_run`.
13. **Git diff/change summary** — implemented as `repo_query` mode `changes`, with status, staged/unstaged numstat summaries, bounded optional diffs, and continuation.
14. **Isolated Codex agent/worktree orchestration** — temporarily ignored. Do not implement or schedule it until explicitly reopened.
15. **HTTP response-body limit** — implemented. The contract is documented in the preceding `http_request` section.

## Codex agent-tool reuse decisions (August 3, 2026)

The Codex core agent registry and the Codex exec-server are different surfaces. CodeHands continues to run only the exec-server. It does not also run Codex app-server or a second Codex agent loop. ChatGPT, Claude, or another MCP client remains the agent.

### Selective Codex reuse rule

Not running app-server does not prevent CodeHands from reusing Codex. Reuse follows these boundaries, in order:

1. Call stable Codex exec-server RPCs directly. This is the preferred path and already covers filesystem, process, environment, and HTTP execution.
2. Build a thin CodeHands MCP convenience contract on top of stable exec-server primitives when it materially reduces model round trips or normalizes results. `process_run` is the canonical example: it composes Codex `process/start`, `process/read`, and `process/terminate` without creating another operating-system process engine.
3. Use a stable standalone Codex binary or library only after a cross-platform compatibility spike confirms that it is an intentional, supportable boundary. The proposed `fs_applyPatch` investigation follows this route.
4. When a Codex capability exists only inside the Codex agent runtime, do not start app-server merely to obtain it and do not copy internal agent handlers blindly. Either implement a deliberately scoped CodeHands-native capability or omit it. `view_image` and the custom `request_user_input` follow this route.

CodeHands must not depend on unstable internal Codex agent-tool APIs. A future stable exec-server RPC may replace a CodeHands internal implementation without forcing a public MCP tool rename.

Current decisions:

- Keep `process_run`. It is a bounded MCP convenience wrapper built on Codex exec-server `process/start`, `process/read`, and `process/terminate`; it is not a second process engine. Do not replace it with Codex core's agent-only `exec_command` unless exec-server later exposes an equivalent stable RPC.
- Keep the current CodeHands `wait` tool. Codex code-mode `wait` waits on a yielded `execute` cell, while Codex `sleep` is tied to an active Codex agent turn. Neither is a standalone exec-server primitive or a drop-in replacement.
- Do not run Codex app-server alongside exec-server merely to obtain agent tools. That would introduce a second agent runtime, thread/turn lifecycle, model authentication, approvals, and additional process ownership.
- Do not add `current_time`; the MCP client or ordinary process execution can obtain time.
- Do not add or track `request_permissions` in the current roadmap.
- `view_image` is implemented as a CodeHands-native capability. It validates workspace paths, MIME signatures, file size, dimensions, and returns standard MCP image content without running Codex app-server.
- `request_user_input` is implemented as a fully custom CodeHands capability using MCP form elicitation. It does not reuse Codex's implementation or couple to Codex threads, turns, or app-server.
- `repo_query` is implemented with `overview`, `tree`, `search`, and `changes` modes.
- `fs_applyPatch` is implemented through a CodeHands-owned native helper that links Codex's existing apply-patch crate rather than maintaining a second parser.
- Ignore the remaining Codex agent-only tools unless a concrete CodeHands use case is explicitly reopened.

The source implementation now contains 24 definitions, handlers, schemas, and tests. A non-elicitation client receives 23 tools; an elicitation-capable client receives all 24. The active server must be restarted and the client/plugin tool snapshot refreshed before an existing installation exposes the new names and schemas.

### Custom `request_user_input` contract (finalized August 3, 2026)

`request_user_input` is a CodeHands-native interactive tool. It does not reuse Codex's implementation and does not require Codex app-server.

Use MCP form elicitation rather than a custom embedded web application. During the originating `tools/call`, CodeHands sends `elicitation/create` through the connected MCP session and waits for the client's response. The MCP client owns the visual presentation; CodeHands requests a simple one-field text form but cannot require an exact visual style.

Tool input:

```json
{
  "message": "Which database should I configure?",
  "label": "Response",
  "placeholder": "Enter your answer",
  "defaultValue": "",
  "required": true,
  "minLength": 0,
  "maxLength": 20000
}
```

Rules:

- This is a singular interactive tool, not a `requests[]` tool.
- It must not be callable through `batch`; nested or concurrent user prompts are rejected.
- `message` is required and explains why input is needed.
- The requested form contains exactly one string property named `value`.
- `label`, `placeholder`, and `defaultValue` are optional presentation hints.
- `required` defaults to `true`.
- `minLength` defaults to `0`; `maxLength` defaults to `20000` and cannot exceed `20000`.
- The tool blocks only while the associated MCP tool call remains active.
- It must not be used for passwords, API keys, access tokens, payment credentials, or other secrets.
- The server checks the initialized client's `elicitation.form` capability before exposing the tool. If the client does not support form elicitation, omit `request_user_input` from that session's `tools/list`; the agent may ask through normal conversation instead.
- The client must provide accept, decline, and cancel semantics. CodeHands does not automatically retry after decline or cancel.
- Do not store submitted values beyond the current tool result or write them to audit logs. Audit only the prompt metadata and final action.

Accepted result:

```json
{
  "action": "accept",
  "value": "PostgreSQL"
}
```

Non-accepted results:

```json
{ "action": "decline" }
```

```json
{ "action": "cancel" }
```

Implementation boundary:

- The installed MCP SDK already provides `server.elicitInput(...)` and client-capability inspection.
- The server layer owns the elicitation call because tool handlers currently do not have access to the connected MCP `Server` instance.
- Add a narrow interaction callback to `ToolContext`, rather than importing MCP SDK types into `packages/mcp-tools`.
- HTTP and stdio transports use the same MCP elicitation contract.
- Add an integration client that advertises form elicitation and verifies accept, decline, cancel, unsupported-client hiding, schema validation, and audit redaction.

This completes the current design discussion. `repo_query`, `fs_applyPatch`, and `view_image` are treated as finalized for implementation according to their recorded decisions; reopen design only if implementation evidence reveals a blocking incompatibility.

### Apply-patch research outcome (August 3, 2026)

The Codex source contains a maintained `codex-apply-patch` Rust crate, a standalone `apply_patch` binary, and an internal Codex agent runtime. It supports add, update, delete, and move operations; missing parent directories; fuzzy context matching; pre-verification APIs; and committed-change deltas. Exec-server does not currently expose a patch RPC.

Do not implement `fs_applyPatch` by blindly invoking the generated `apply_patch` alias or the hidden `codex --codex-run-as-apply-patch` path. Direct testing found that the raw standalone route:

- runs without the internal agent runtime's filesystem sandbox context and permits relative paths such as `../outside.txt`;
- can commit earlier file changes before a later hunk fails;
- rewrites a changed line in a CRLF file with LF, producing mixed line endings;
- treats an Add File hunk as an overwrite when the destination already exists;
- returns only process exit status and text summaries rather than a stable structured contract;
- exposes `apply_patch` through a temporary per-Codex-session alias and a hidden internal dispatch flag, not a stable exec-server RPC;
- requires exact argv handling on Windows because the generated batch alias does not support stdin through the hidden internal dispatch path.

Preferred integration order:

1. Prefer a future stable Codex exec-server patch RPC and keep the public CodeHands tool contract independent of the underlying RPC name.
2. If implementation proceeds before such an RPC exists, build a small CodeHands-owned native helper that links the maintained `codex-apply-patch` crate. The helper must expose a versioned JSON protocol, must not copy Codex's parser, and must mirror Codex's pinned Cargo workspace patches and lockfile inputs deliberately rather than resolving unrelated upstream versions.
3. The helper must pre-parse and pre-verify the full patch, resolve every source and destination path, enforce CodeHands workspace confinement including symlink/junction handling, and support dry-run output before applying.
4. The helper must return structured applied-change data, including whether failure was partial and whether the committed delta is exact. It must never claim all-or-nothing behavior.
5. CodeHands rejects Add File and move-destination overwrites by default unless `allowOverwrite` is explicit, and preserves the dominant CRLF style for updated CRLF files when `preserveLineEndings` is enabled.
6. The helper builds reproducibly from a pinned lockfile, is copied from Cargo's configured target directory into a stable repository-local runtime path, and is validated on Windows. macOS and Linux packaging remain future compatibility work rather than blockers for the current trusted Windows deployment.

Current status: implemented and validated through the native-helper route. The raw Codex alias and hidden dispatch flag remain prohibited implementation paths.

## Basic tests and validation

The focused current-version validation suite covers:

- one-item and eight-item request boundaries across every changed tool
- rejection of old singular inputs for tools migrated to `requests[]`
- stable input/result ordering
- partial item failure across every changed tool
- concurrent multi-item `fs_walk`
- sequential multi-item `process_start`, `process_write`, and `http_request`
- bounded `http_request` bodies with `returnedBytes`, `totalBytes`, and `bodyTruncated`
- `process_run` success
- `process_run` non-zero exit
- `process_run` timeout
- rejection of a `process_run` timeout above 60 seconds
- timeout termination uses `process_terminate`
- sequential file writes, directory creation, copies, removals, signals, and terminations
- optional `process_run` parallelism remains capped at three
- concurrent one-to-eight `process_read` requests with per-item waits
- `process_read` returns ordered decoded `{ seq, stream, text }` chunks without base64 or duplicated aggregated output
- basic continuation using directly reusable `nextOffset`, `nextFromLine`, and `nextAfterSeq`
- `process_signal` and `process_terminate` remain separate tools
- every public tool advertises `outputSchema`
- non-error results return schema-conforming `structuredContent`
- text `content` contains equivalent serialized JSON
- representative success, partial-failure, timeout, and continuation results validate against their schemas
- existing path validation, malformed-request handling, request-size limits, audit redaction, and secret-redaction tests continue to pass
- `codehands logs` keeps singular calls on one line, groups multi-request calls under one summary line, and prints each request or batch item on its own indented line
- live logs distinguish `idle` time before a call from active `took`/`elapsed` time, label intentional `process_read` waits as `long-poll`, and show per-child batch/process status and duration from redacted audit outcome metadata
- `repo_query` overview, tree, path/content search, changes, result bounds, and continuation
- `view_image` MIME/signature validation, dimensions, size limits, and MCP image content
- `request_user_input` capability hiding, accept/decline/cancel, validation, batch rejection, secret rejection, and HTTP elicitation
- `fs_applyPatch` dry-run, add/update behavior, absolute/traversal rejection, overwrite rejection, CRLF preservation, preflight-before-mutation, structured results, and MCP `isError` on singular helper rejection

Validation completed on August 3, 2026:

- `pnpm check` passes: TypeScript build, pinned native release build, 11 Vitest files with 102 tests, and seven native patch-helper filesystem checks.
- The in-memory MCP client/server tests confirm deterministic `outputSchema`, matching `structuredContent`, capability-gated tool listing, and elicitation accept/decline/cancel behavior.
- `node tests/correctness-smoke.mjs` passes against the real Codex exec-server, including block-based file reads, `process_run`, process continuation, stdin, signal/termination, and batch behavior.
- `node tests/integration.mjs` passes against an isolated built CodeHands server on port 3101: 50 checks passed and 0 failed.
- `node tests/new-tools-integration.mjs` passes against the isolated HTTP server: 15 checks for tool listing, repository queries, dry-run and real MCP patch application, and image content.
- `node tests/elicitation-http-integration.mjs` passes through Streamable HTTP: six checks covering 24-tool capability listing, nested form elicitation, schema, text output, and structured output.
- A disposable CodeHands V3 stress harness passes 94 checks across eight concurrent MCP clients, maximum-size batches, filesystem continuations, process timeouts and output continuation, junction confinement outside approved workspaces, repository queries, patch safety, image limits, malformed and oversized HTTP requests, and accept/decline/cancel elicitation.
- An isolated real-process crash test force-terminates the Codex child, observes exactly one `restarting (1/3)` event, confirms exactly one replacement `codex.exe`, and completes a post-recovery filesystem read.
- A live `codehands logs` test confirms grouped batch output, `idle` versus active elapsed time, per-child durations, `PARTIAL`, and explicit nested `TIMEOUT` rendering.
- `git diff --check` passes with only existing line-ending warnings. The isolated server and temporary config are removed after validation; the active port-3100 instance remains untouched until the explicit deployment restart.

Do not make broader benchmark or cross-platform programs blockers for the current version.

## Deferred to version 3

- endpoint authentication and authorization
- per-user or per-agent permissions
- localhost-only binding requirements
- tunnel and remote-access policy
- command permission profiles and approval workflows
- workspace or process isolation
- extensive Windows, macOS, and Linux integration matrices
- broad real-Codex integration-suite expansion
- performance and latency benchmark programs
- exhaustive continuation-through-EOF suites beyond basic coverage
- dependency and lockfile cleanup
- dependency-version alignment
- Vitest warning cleanup
- placeholder gateway cleanup
- broad repository cleanup
- replacement ChatGPT plugin snapshot
- stronger Git force-push policy discussion
- global `allowShell` configuration discussion
- advanced process-registry and restart-diagnostic discussion
- secondary process-output retention discussion only; not approved for implementation

## Design status

The 24-definition implementation is complete. Sessions without form elicitation expose 23 tools; sessions with `elicitation.form` expose all 24. Remaining items are either explicitly rejected or deferred to version 3. No current tool-design discussion remains open.
