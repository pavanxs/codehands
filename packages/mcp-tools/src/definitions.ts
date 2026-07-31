export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- File System ---
  {
    name: "fs_readFile",
    description: "Read the contents of a file at the given path. Returns the file content as text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative file path" },
        startLine: { type: "integer", minimum: 1, description: "Optional first line to return (1-based)" },
        endLine: { type: "integer", minimum: 1, description: "Optional last line to return (inclusive)" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_replaceText",
    description: "Replace exact text in a file. Fails safely if the expected old text is absent or ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative file path" },
        oldText: { type: "string", description: "Exact existing text to replace" },
        newText: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace every match instead of requiring exactly one", default: false },
      },
      required: ["path", "oldText", "newText"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_applyPatch",
    description: "Apply unified-diff hunks to one file with context verification. The path is supplied separately and patch headers are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path" },
        patch: { type: "string", description: "Unified diff containing one or more @@ hunks" },
      },
      required: ["path", "patch"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_searchText",
    description: "Search for text or a regular expression inside the active workspace. Returns matching paths, line numbers, and lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regular expression to search for" },
        path: { type: "string", description: "Optional workspace-relative directory or file", default: "." },
        glob: { type: "string", description: "Optional file glob such as *.ts" },
        fixedStrings: { type: "boolean", description: "Treat query as literal text", default: false },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_writeFile",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative file path" },
        content: { type: "string", description: "Text content to write" },
      },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_createDirectory",
    description: "Create a directory. Creates parent directories if they don't exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to create" },
        recursive: { type: "boolean", description: "Create parent dirs (default true)", default: true },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_readDirectory",
    description: "List the contents of a directory. Returns file names and whether each is a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_walk",
    description: "Recursively walk a directory tree. Returns all files and folders nested within.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root directory to walk" },
        maxDepth: { type: "number", description: "Maximum recursion depth" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_remove",
    description: "Delete a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to delete" },
        recursive: { type: "boolean", description: "Delete directory contents recursively", default: false },
        force: { type: "boolean", description: "Ignore errors if path doesn't exist", default: false },
      },
      required: ["path"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_copy",
    description: "Copy a file or directory to a new location.",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "Source path" },
        destinationPath: { type: "string", description: "Destination path" },
        recursive: { type: "boolean", description: "Copy directory contents recursively", default: false },
      },
      required: ["sourcePath", "destinationPath"],
    },
  },
  {
    name: "fs_getMetadata",
    description: "Get metadata about a file or directory: type, size, timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to inspect" },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },

  // --- Process ---
  {
    name: "process_start",
    description: "Start an executable directly without shell interpretation. Put every argument in args. Returns a session-owned process ID.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable name or path (for example npm, with test in args)" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments as separate strings",
        },
        cwd: { type: "string", description: "Working directory (defaults to active workspace)" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra environment variables",
        },
        tty: { type: "boolean", description: "Allocate a PTY (interactive terminal)", default: false },
      },
      required: ["command"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_read",
    description: "Read stdout/stderr output from a running or completed process.",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process ID from process_start" },
        afterSeq: { type: "number", description: "Only return output after this sequence number" },
        waitMs: { type: "number", description: "Wait up to this many ms for new output" },
      },
      required: ["processId"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_write",
    description: "Send text input to a running process (like typing into a terminal).",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process ID from process_start" },
        input: { type: "string", description: "Text to send to the process stdin" },
      },
      required: ["processId", "input"],
    },
  },
  {
    name: "process_terminate",
    description: "Kill a running process immediately.",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process ID from process_start" },
      },
      required: ["processId"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "process_signal",
    description: "Send an interrupt signal (like Ctrl+C) to a running process.",
    inputSchema: {
      type: "object",
      properties: {
        processId: { type: "string", description: "Process ID from process_start" },
        signal: {
          type: "string",
          enum: ["interrupt"],
          description: "Signal to send",
          default: "interrupt",
        },
      },
      required: ["processId"],
    },
  },

  // --- HTTP ---
  {
    name: "http_request",
    description: "Make an HTTP request allowed by the configured host, method, protocol, and private-network policy. Disabled by default.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], description: "HTTP method" },
        url: { type: "string", description: "Full URL to request" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Request headers",
        },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds" },
      },
      required: ["method", "url"],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },

  // --- Workspace ---
  {
    name: "workspace_list",
    description: "List all approved workspaces (project folders) that you can access.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workspace_set",
    description: "Set the active workspace for this session. After this, file paths can be relative to this workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Workspace path or name from workspace_list" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "git_status",
    description: "Return concise Git working-tree and branch status for the active workspace.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "git_diff",
    description: "Return a non-colored Git diff for the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Show staged changes", default: false },
        path: { type: "string", description: "Optional workspace-relative path to limit the diff" },
        base: { type: "string", description: "Optional trusted Git revision to diff against" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "activity_recent",
    description: "Show recent sanitized CodeHands tool activity for this MCP session, including durations and failures.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    annotations: { readOnlyHint: true },
  },
];
