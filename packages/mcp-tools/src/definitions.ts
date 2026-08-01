export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
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
      },
      required: ["path"],
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
    description: "Start a terminal command. Returns a process ID to read output or send input later.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run (e.g. 'npm test')" },
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
    description: "Make an HTTP request from the local machine. Like curl.",
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

  // --- Utility ---
  {
    name: "wait",
    description: "Wait for a specified duration before continuing. Useful after starting a process that needs time to initialize.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Duration to wait in milliseconds (max 30000)" },
      },
      required: ["ms"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_list",
    description: "List all processes started by this session. Shows which are still running and which have exited.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "batch",
    description: "Run multiple tools in one request, all in parallel. Returns all results together. Use to avoid round-trip overhead.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          description: "Array of tool calls to execute in parallel",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Tool name (e.g. fs_readFile, process_start)" },
              args: { type: "object", description: "Arguments for the tool" },
            },
            required: ["tool", "args"],
          },
        },
      },
      required: ["calls"],
    },
  },
];
