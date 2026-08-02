export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const pathProperty = { type: "string", description: "Absolute or workspace-relative path" };
const maxOutputProperty = { type: "integer", minimum: 1, maximum: 1_048_576, description: "Maximum UTF-8 output bytes (default 65536, hard cap 1048576)" };
const timeoutProperty = { type: "integer", minimum: 1, maximum: 600_000, description: "Timeout in milliseconds (default 120000, hard cap 600000)" };
const commandProperties = {
  command: { type: "string", minLength: 1, description: "Executable name or path; never parsed as shell syntax" },
  args: { type: "array", maxItems: 1000, items: { type: "string" }, description: "Literal argv entries" },
  cwd: { type: "string", description: "Approved working directory (defaults to active workspace)" },
  env: { type: "object", additionalProperties: { type: "string" }, description: "Extra environment variables" },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "fs_readFile",
    description: "Read a text file with bounded output and truncation metadata.",
    inputSchema: { type: "object", properties: { path: pathProperty, maxOutputBytes: maxOutputProperty }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_writeFile",
    description: "Write text to a file, creating or replacing it inside an approved workspace.",
    inputSchema: { type: "object", properties: { path: pathProperty, content: { type: "string" } }, required: ["path", "content"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_createDirectory",
    description: "Create a directory inside an approved workspace.",
    inputSchema: { type: "object", properties: { path: pathProperty, recursive: { type: "boolean", default: true } }, required: ["path"] },
  },
  {
    name: "fs_readDirectory",
    description: "List a bounded, paginated range of directory entries.",
    inputSchema: { type: "object", properties: { path: pathProperty, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_walk",
    description: "Walk a bounded directory tree with explicit symlink behavior.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        maxDepth: { type: "integer", minimum: 0, maximum: 100 },
        maxDirectories: { type: "integer", minimum: 1, maximum: 10000 },
        maxEntries: { type: "integer", minimum: 1, maximum: 50000 },
        followDirectorySymlinks: { type: "boolean", default: false, description: "Whether directory symlinks may be followed" },
        maxOutputBytes: maxOutputProperty,
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_remove",
    description: "Delete a file or directory inside an approved workspace.",
    inputSchema: { type: "object", properties: { path: pathProperty, recursive: { type: "boolean", default: false }, force: { type: "boolean", default: false } }, required: ["path"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_copy",
    description: "Copy a file or directory between approved paths.",
    inputSchema: { type: "object", properties: { sourcePath: pathProperty, destinationPath: pathProperty, recursive: { type: "boolean", default: false } }, required: ["sourcePath", "destinationPath"] },
  },
  {
    name: "fs_getMetadata",
    description: "Get file or directory type, size, and timestamp metadata.",
    inputSchema: { type: "object", properties: { path: pathProperty }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_readRange",
    description: "Read a bounded line range from a text file with line numbers.",
    inputSchema: { type: "object", properties: { path: pathProperty, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maxOutputBytes: maxOutputProperty }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_search",
    description: "Search file text or paths with ripgrep using bounded literal argv execution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 }, path: pathProperty,
        mode: { type: "string", enum: ["text", "path"], default: "text" },
        regex: { type: "boolean", default: false },
        include: { type: "array", maxItems: 50, items: { type: "string" } },
        exclude: { type: "array", maxItems: 50, items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: 500 }, maxOutputBytes: maxOutputProperty,
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_applyPatch",
    description: "Validate or apply a unified Git patch inside an approved repository.",
    inputSchema: { type: "object", properties: { patch: { type: "string", minLength: 1 }, path: pathProperty, dryRun: { type: "boolean", default: false } }, required: ["patch"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_start",
    description: "Start an interactive or long-running executable with literal argv; shell syntax is never interpreted.",
    inputSchema: { type: "object", properties: { ...commandProperties, tty: { type: "boolean", default: false } }, required: ["command"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_startShell",
    description: "Explicitly start a shell script; available only when allowShell is enabled in config.",
    inputSchema: { type: "object", properties: { script: { type: "string", minLength: 1 }, cwd: commandProperties.cwd, env: commandProperties.env, tty: { type: "boolean", default: false } }, required: ["script"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_run",
    description: "Run a finite executable with literal argv and return bounded stdout, stderr, and exit status in one call.",
    inputSchema: { type: "object", properties: { ...commandProperties, timeoutMs: timeoutProperty, maxOutputBytes: maxOutputProperty }, required: ["command"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_read",
    description: "Read bounded output and reconcile status for a started process.",
    inputSchema: { type: "object", properties: { processId: { type: "string" }, afterSeq: { type: "integer", minimum: 0 }, waitMs: { type: "integer", minimum: 0, maximum: 30000 }, maxOutputBytes: maxOutputProperty }, required: ["processId"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_write",
    description: "Write text to the standard input of a running process.",
    inputSchema: { type: "object", properties: { processId: { type: "string" }, input: { type: "string" } }, required: ["processId", "input"] },
  },
  {
    name: "process_terminate",
    description: "Terminate a running process and retain its terminal status for diagnostics.",
    inputSchema: { type: "object", properties: { processId: { type: "string" } }, required: ["processId"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_signal",
    description: "Send an interrupt signal to a reconciled running process.",
    inputSchema: { type: "object", properties: { processId: { type: "string" }, signal: { type: "string", enum: ["interrupt"], default: "interrupt" } }, required: ["processId"] },
  },
  {
    name: "process_list",
    description: "List reconciled processes using compact, filtered, paginated summaries.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["running", "stale", "exited", "terminated", "lost"] }, session: { type: "string", enum: ["all", "current"], default: "all" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 }, compact: { type: "boolean", default: true } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "http_request",
    description: "Make an HTTP request and return a bounded response body.",
    inputSchema: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] }, url: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" }, timeoutMs: { type: "integer", minimum: 1 }, maxOutputBytes: maxOutputProperty }, required: ["method", "url"] },
  },
  {
    name: "workspace_list",
    description: "List approved workspaces and the active workspace.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
  },
  {
    name: "workspace_set",
    description: "Select an approved active workspace for relative paths.",
    inputSchema: { type: "object", properties: { workspace: { type: "string" } }, required: ["workspace"] },
  },
  {
    name: "repo_snapshot",
    description: "Return a compact repository branch, HEAD, status, remotes, and package/test hint snapshot.",
    inputSchema: { type: "object", properties: { path: pathProperty, maxOutputBytes: maxOutputProperty } }, annotations: { readOnlyHint: true },
  },
  {
    name: "test_run",
    description: "Run a named test command from CodeHands config and return a compact bounded result.",
    inputSchema: { type: "object", properties: { name: { type: "string", default: "default" }, timeoutMs: timeoutProperty, maxOutputBytes: maxOutputProperty } },
    annotations: { destructiveHint: true },
  },
  {
    name: "git_diff_summary",
    description: "Return compact Git status, changed-file, and diff-stat summaries, optionally against a base ref.",
    inputSchema: { type: "object", properties: { path: pathProperty, baseRef: { type: "string" }, maxOutputBytes: maxOutputProperty } }, annotations: { readOnlyHint: true },
  },
  {
    name: "agent_start",
    description: "Create an isolated worktree and launch one explicit Codex exec worker without merging or pushing.",
    inputSchema: { type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 20000 }, repository: pathProperty, branch: { type: "string" }, model: { type: "string" }, sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "workspace-write" } }, required: ["task"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "agent_status",
    description: "Return compact reconciled status for an explicit Codex worker.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] }, annotations: { readOnlyHint: true },
  },
  {
    name: "agent_results",
    description: "Return bounded worker output plus its isolated branch, worktree, status, and diff summary.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, maxOutputBytes: maxOutputProperty }, required: ["agentId"] }, annotations: { readOnlyHint: true },
  },
  {
    name: "agent_cancel",
    description: "Terminate an explicit worker and optionally remove its isolated worktree and branch.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, cleanup: { type: "boolean", default: false } }, required: ["agentId"] }, annotations: { destructiveHint: true },
  },
  {
    name: "agent_run_many",
    description: "Start up to four independent workers in parallel with no dependency graph or automatic merge.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array", minItems: 1, maxItems: 4,
          items: { type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 20000 }, repository: pathProperty, branch: { type: "string" }, model: { type: "string" }, sandbox: { type: "string", enum: ["read-only", "workspace-write"] } }, required: ["task"] },
        },
      },
      required: ["tasks"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "wait",
    description: "Wait up to thirty seconds before the next client-directed step.",
    inputSchema: { type: "object", properties: { ms: { type: "integer", minimum: 0, maximum: 30000 } }, required: ["ms"] }, annotations: { readOnlyHint: true },
  },
  {
    name: "batch",
    description: "Run up to twenty explicitly supplied independent tool calls in parallel.",
    inputSchema: { type: "object", properties: { calls: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool", "args"] } } }, required: ["calls"] },
  },
];
