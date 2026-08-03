export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

type Schema = Record<string, unknown>;

const errorSchema: Schema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["code", "message"],
};

const successProperty = { type: "boolean" };
const pathProperty = { type: "string", description: "Absolute or workspace-relative path" };
const processIdProperty = { type: "string", description: "CodeHands-managed process ID" };

function requestEnvelope(
  itemProperties: Record<string, unknown>,
  required: string[],
  extraProperties: Record<string, unknown> = {},
  extraRequired: string[] = [],
): Schema {
  return {
    type: "object",
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: itemProperties,
          required,
          additionalProperties: false,
        },
      },
      ...extraProperties,
    },
    required: ["requests", ...extraRequired],
  };
}

function resultEnvelope(
  itemProperties: Record<string, unknown>,
  required: string[],
): Schema {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ...itemProperties,
            success: successProperty,
            error: errorSchema,
          },
          required: [...required, "success"],
        },
      },
    },
    required: ["results"],
  };
}

const commandRequestProperties: Record<string, unknown> = {
  command: {
    type: "string",
    description: "Executable name when shell is false; shell command text when shell is true",
  },
  args: {
    type: "array",
    items: { type: "string" },
    description: "Exact executable arguments. Valid only when shell is false.",
  },
  shell: {
    type: "boolean",
    description: "false executes command and args directly; true executes command through the Codex-detected shell",
  },
  cwd: { type: "string", description: "Workspace-relative working directory; '.' means workspace root" },
  env: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Additional environment variables",
  },
  tty: { type: "boolean", default: false },
};

const processRunRequestProperties: Record<string, unknown> = Object.fromEntries(
  Object.entries(commandRequestProperties).filter(([name]) => name !== "tty"),
);

const commandIdentityOutput: Record<string, unknown> = {
  command: { type: "string" },
  args: { type: "array", items: { type: "string" } },
  shell: { type: "boolean" },
  cwd: { type: "string" },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "fs_readFile",
    description: "Read one to eight files with optional line or byte windows and directly reusable continuation fields.",
    inputSchema: requestEnvelope({
      path: pathProperty,
      fromLine: { type: "integer", minimum: 1 },
      toLine: { type: "integer", minimum: 1 },
      maxChars: { type: "integer", minimum: 1, maximum: 20_000, default: 20_000 },
      offset: { type: "integer", minimum: 0 },
      maxBytes: { type: "integer", minimum: 1, maximum: 20_000, default: 20_000 },
    }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      mode: { type: "string", enum: ["line", "byte"] },
      content: { type: "string" },
      eof: { type: "boolean" },
      fromLine: { type: "integer" },
      toLine: { type: "integer" },
      totalLines: { type: "integer" },
      returnedChars: { type: "integer" },
      nextFromLine: { type: "integer" },
      offset: { type: "integer" },
      returnedBytes: { type: "integer" },
      nextOffset: { type: "integer" },
    }, ["path"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_writeFile",
    description: "Write one to eight files sequentially in request order.",
    inputSchema: requestEnvelope({
      path: pathProperty,
      content: { type: "string", description: "UTF-8 text content to write" },
    }, ["path", "content"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      written: { type: "boolean" },
      bytes: { type: "integer" },
    }, ["path"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_createDirectory",
    description: "Create one to eight directories sequentially, optionally creating parents.",
    inputSchema: requestEnvelope({
      path: pathProperty,
      recursive: { type: "boolean", default: true },
    }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      created: { type: "boolean" },
    }, ["path"]),
  },
  {
    name: "fs_readDirectory",
    description: "List one to eight directories concurrently while preserving request order.",
    inputSchema: requestEnvelope({ path: pathProperty }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      entries: { type: "array", items: { type: "object" } },
    }, ["path"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_walk",
    description: "Walk one to eight directory trees concurrently with bounded traversal options.",
    inputSchema: requestEnvelope({
      path: pathProperty,
      maxDepth: { type: "integer", minimum: 0 },
      followDirectorySymlinks: { type: "boolean", default: false },
    }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      data: {},
    }, ["path"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_remove",
    description: "Remove one to eight files or directories sequentially in request order.",
    inputSchema: requestEnvelope({
      path: pathProperty,
      recursive: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      removed: { type: "boolean" },
    }, ["path"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "fs_copy",
    description: "Copy one to eight files or directories sequentially in request order.",
    inputSchema: requestEnvelope({
      sourcePath: { type: "string" },
      destinationPath: { type: "string" },
      recursive: { type: "boolean", default: false },
    }, ["sourcePath", "destinationPath"]),
    outputSchema: resultEnvelope({
      sourcePath: { type: "string" },
      destinationPath: { type: "string" },
      copied: { type: "boolean" },
    }, ["sourcePath", "destinationPath"]),
  },
  {
    name: "fs_getMetadata",
    description: "Get metadata for one to eight filesystem paths concurrently.",
    inputSchema: requestEnvelope({ path: pathProperty }, ["path"]),
    outputSchema: resultEnvelope({
      path: { type: "string" },
      isDirectory: { type: "boolean" },
      isFile: { type: "boolean" },
      isSymlink: { type: "boolean" },
      size: { type: "integer" },
      createdAtMs: { type: "number" },
      modifiedAtMs: { type: "number" },
    }, ["path"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "repo_query",
    description: "Inspect a Git repository using overview, tree, search, or changes modes with bounded structured results.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["overview", "tree", "search", "changes"] },
        path: { type: "string", default: ".", description: "Workspace-relative repository path" },
        query: { type: "string", description: "Required for search mode" },
        searchIn: { type: "string", enum: ["content", "path"], default: "content" },
        patternType: { type: "string", enum: ["literal", "regex", "glob"], default: "literal" },
        caseSensitive: { type: "boolean", default: false },
        maxDepth: { type: "integer", minimum: 0, maximum: 20, default: 6 },
        maxResults: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
        includeDiff: { type: "boolean", default: false },
        maxDiffChars: { type: "integer", minimum: 1, maximum: 20_000, default: 12_000 },
      },
      required: ["mode"],
    },
    outputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["overview", "tree", "search", "changes"] },
        path: { type: "string" },
        relativePath: { type: "string" },
        success: { type: "boolean" },
        branch: { type: ["string", "null"] },
        fileCount: { type: "integer" },
        changedFileCount: { type: "integer" },
        topLevel: { type: "array", items: { type: "object" } },
        entries: { type: "array", items: { type: "object" } },
        matches: { type: "array", items: { type: "object" } },
        status: { type: "array", items: { type: "object" } },
        changes: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
        truncated: { type: "boolean" },
        nextOffset: { type: "integer" },
        diff: { type: "string" },
        diffTruncated: { type: "boolean" },
        error: errorSchema,
      },
      required: ["mode", "path", "success"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fs_applyPatch",
    description: "Verify and apply one Codex-format patch inside the active workspace through the CodeHands native patch bridge.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", maxLength: 200_000 },
        cwd: { type: "string", default: "." },
        dryRun: { type: "boolean", default: false },
        allowOverwrite: { type: "boolean", default: false },
        preserveLineEndings: { type: "boolean", default: true },
        maxFiles: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["patch"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        dryRun: { type: "boolean" },
        partialApplied: { type: "boolean" },
        deltaExact: { type: "boolean" },
        changes: { type: "array", items: { type: "object" } },
        error: errorSchema,
      },
      required: ["success", "dryRun", "partialApplied", "deltaExact", "changes"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "view_image",
    description: "Read and return one validated workspace image as MCP image content with structured metadata.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        success: { type: "boolean" },
        mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
        bytes: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["path", "success", "mimeType", "bytes", "width", "height"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_run",
    description: "Run one to eight bounded commands and return their final stdout, stderr, exit status, timeout state, and continuation when output is truncated.",
    inputSchema: requestEnvelope({
      ...processRunRequestProperties,
      timeoutMs: { type: "integer", minimum: 100, maximum: 60_000, default: 30_000 },
      maxStdoutChars: { type: "integer", minimum: 1, maximum: 20_000, default: 20_000 },
      maxStderrChars: { type: "integer", minimum: 1, maximum: 10_000, default: 10_000 },
    }, ["command", "shell"], {
      execution: { type: "string", enum: ["sequential", "parallel"], default: "sequential" },
      maxConcurrency: { type: "integer", minimum: 1, maximum: 3, default: 3 },
    }),
    outputSchema: resultEnvelope({
      ...commandIdentityOutput,
      status: { type: "string", enum: ["succeeded", "failed", "timed_out"] },
      exitCode: { type: ["integer", "null"] },
      timedOut: { type: "boolean" },
      durationMs: { type: "number" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      stdoutTruncated: { type: "boolean" },
      stderrTruncated: { type: "boolean" },
      processId: { type: "string" },
      nextAfterSeq: { type: "integer" },
    }, ["command", "shell"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "process_start",
    description: "Start one to eight long-running or interactive processes sequentially and return process IDs.",
    inputSchema: requestEnvelope(commandRequestProperties, ["command", "shell"]),
    outputSchema: resultEnvelope({
      ...commandIdentityOutput,
      processId: { type: "string" },
      started: { type: "boolean" },
      mode: { type: "string", enum: ["direct", "shell"] },
      argv: { type: "array", items: { type: "string" } },
      shellInfo: { type: "object" },
    }, ["command", "shell"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "process_read",
    description: "Read ordered decoded output chunks from one to eight CodeHands-managed processes concurrently.",
    inputSchema: requestEnvelope({
      processId: processIdProperty,
      afterSeq: { type: "integer", minimum: 0, description: "Return chunks after this sequence number" },
      maxBytes: { type: "integer", minimum: 1, maximum: 60_000 },
      waitMs: { type: "integer", minimum: 0 },
    }, ["processId"]),
    outputSchema: resultEnvelope({
      processId: { type: "string" },
      chunks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            seq: { type: "integer" },
            stream: { type: "string", enum: ["stdout", "stderr", "pty"] },
            text: { type: "string" },
          },
          required: ["seq", "stream", "text"],
        },
      },
      nextAfterSeq: { type: "integer" },
      exited: { type: "boolean" },
      exitCode: { type: ["integer", "null"] },
      closed: { type: "boolean" },
      failure: { type: ["string", "null"] },
      sandboxDenied: { type: "boolean" },
    }, ["processId"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "process_write",
    description: "Send input to one to eight running processes sequentially.",
    inputSchema: requestEnvelope({
      processId: processIdProperty,
      input: { type: "string" },
    }, ["processId", "input"]),
    outputSchema: resultEnvelope({
      processId: { type: "string" },
      status: { type: "string", enum: ["accepted", "unknownProcess", "stdinClosed", "starting"] },
    }, ["processId"]),
  },
  {
    name: "process_signal",
    description: "Send graceful interrupt requests to one to eight processes sequentially.",
    inputSchema: requestEnvelope({
      processId: processIdProperty,
      signal: { type: "string", enum: ["interrupt"], default: "interrupt" },
    }, ["processId"]),
    outputSchema: resultEnvelope({
      processId: { type: "string" },
      signalSent: { type: "string", enum: ["interrupt"] },
    }, ["processId"]),
  },
  {
    name: "process_terminate",
    description: "Forcefully terminate one to eight processes sequentially.",
    inputSchema: requestEnvelope({ processId: processIdProperty }, ["processId"]),
    outputSchema: resultEnvelope({
      processId: { type: "string" },
      wasRunning: { type: "boolean" },
    }, ["processId"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "process_list",
    description: "List the global CodeHands-managed process registry.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        processes: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
      },
      required: ["processes", "total"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "http_request",
    description: "Perform one to eight buffered HTTP requests sequentially with bounded response bodies and optional Codex timeoutMs.",
    inputSchema: requestEnvelope({
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] },
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      timeoutMs: { type: "integer", minimum: 0 },
      maxResponseBytes: { type: "integer", minimum: 1, maximum: 60_000, default: 60_000 },
    }, ["method", "url"]),
    outputSchema: resultEnvelope({
      method: { type: "string" },
      url: { type: "string" },
      status: { type: "integer" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      returnedBytes: { type: "integer" },
      totalBytes: { type: "integer" },
      bodyTruncated: { type: "boolean" },
    }, ["method", "url"]),
  },
  {
    name: "workspace_list",
    description: "List approved workspaces and the current global active workspace.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        workspaces: { type: "array", items: { type: "string" } },
        activeWorkspace: { type: ["string", "null"] },
      },
      required: ["workspaces", "activeWorkspace"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "workspace_set",
    description: "Set the global active workspace shared by all connected agents.",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
      required: ["workspace"],
    },
    outputSchema: {
      type: "object",
      properties: {
        activeWorkspace: { type: "string" },
        set: { type: "boolean" },
      },
      required: ["activeWorkspace", "set"],
    },
  },
  {
    name: "request_user_input",
    description: "Display a simple one-field MCP input form and return whether the user accepted, declined, or cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 4000 },
        label: { type: "string", maxLength: 200, default: "Response" },
        placeholder: { type: "string", maxLength: 500 },
        defaultValue: { type: "string", maxLength: 20_000 },
        required: { type: "boolean", default: true },
        minLength: { type: "integer", minimum: 0, maximum: 20_000, default: 0 },
        maxLength: { type: "integer", minimum: 1, maximum: 20_000, default: 20_000 },
      },
      required: ["message"],
    },
    outputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "decline", "cancel"] },
        value: { type: "string" },
      },
      required: ["action"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wait",
    description: "Wait for a bounded duration before continuing.",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "integer", minimum: 0, maximum: 30_000 } },
      required: ["ms"],
    },
    outputSchema: {
      type: "object",
      properties: { waited: { type: "integer" } },
      required: ["waited"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "batch",
    description: "Run heterogeneous CodeHands tool calls in parallel to reduce round trips. This is not JSON-RPC protocol batching.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              args: { type: "object" },
            },
            required: ["tool", "args"],
            additionalProperties: false,
          },
        },
      },
      required: ["calls"],
    },
    outputSchema: {
      type: "object",
      properties: {
        results: { type: "array", items: { type: "object" } },
        total: { type: "integer" },
      },
      required: ["results", "total"],
    },
  },
];
