export type ProcessId = string;

export interface FileSystemSandboxEntry {
  path:
    | { type: "path"; path: string }
    | { type: "glob_pattern"; pattern: string }
    | { type: "special"; value: { kind: "root" | "minimal" | "project_roots" | "tmpdir" | "slash_tmp"; subpath?: string } };
  access: "read" | "write" | "deny";
  missing_path_behavior?: "error" | "skip";
}

export interface FileSystemSandboxContext {
  permissions: {
    type: "managed";
    file_system: {
      type: "restricted";
      entries: FileSystemSandboxEntry[];
      glob_scan_max_depth?: number;
    };
    network: "restricted" | "enabled";
  };
  cwd: string;
  workspaceRoots: string[];
  windowsSandboxLevel: "disabled" | "restricted-token" | "elevated";
  windowsSandboxPrivateDesktop?: boolean;
  useLegacyLandlock?: boolean;
}

export function createWorkspaceSandbox(
  workspaceUri: string,
  options: { network?: "restricted" | "enabled"; readOnly?: boolean } = {},
): FileSystemSandboxContext {
  const entries: FileSystemSandboxEntry[] = [
    {
      path: { type: "special", value: { kind: "minimal" } },
      access: "read",
    },
    {
      path: { type: "special", value: { kind: "project_roots" } },
      access: options.readOnly ? "read" : "write",
    },
    {
      path: { type: "special", value: { kind: "tmpdir" } },
      access: "write",
    },
    {
      path: { type: "special", value: { kind: "slash_tmp" } },
      access: "write",
      missing_path_behavior: "skip",
    },
  ];
  if (process.platform === "darwin") {
    for (const runtimePath of [
      "file:///System/Library/OpenSSL",
      "file:///Library/Developer",
      "file:///Applications/Xcode.app",
    ]) {
      entries.push({
        path: { type: "path", path: runtimePath },
        access: "read",
        missing_path_behavior: "skip",
      });
    }
  }

  return {
    permissions: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries,
      },
      network: options.network ?? "restricted",
    },
    cwd: workspaceUri,
    workspaceRoots: [workspaceUri],
    windowsSandboxLevel: "restricted-token",
    windowsSandboxPrivateDesktop: false,
    useLegacyLandlock: false,
  };
}

export interface InitializeParams {
  clientName: string;
  resumeSessionId?: string;
}

export interface InitializeResponse {
  sessionId: string;
}

export interface ExecParams {
  processId: ProcessId;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  tty?: boolean;
  pipeStdin?: boolean;
  sandbox: FileSystemSandboxContext;
  enforceManagedNetwork?: boolean;
}

export interface ExecResponse {
  processId: ProcessId;
  sandboxType?: "none" | "macosSeatbelt" | "linuxSeccomp" | "windowsRestrictedToken";
}

export interface ReadParams {
  processId: ProcessId;
  afterSeq?: number;
  maxBytes?: number;
  waitMs?: number;
}

export interface ProcessOutputChunk {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  chunk: string; // base64-encoded
}

export interface ReadResponse {
  chunks: ProcessOutputChunk[];
  nextSeq: number;
  exited: boolean;
  exitCode?: number;
  closed: boolean;
  failure?: string;
  sandboxDenied?: boolean;
}

export interface WriteParams {
  processId: ProcessId;
  chunk: string; // base64-encoded
  writeId: string;
}

export interface WriteResponse {
  status: "accepted" | "unknownProcess" | "stdinClosed" | "starting";
}

export interface SignalParams {
  processId: ProcessId;
  signal: "interrupt";
}

export interface SignalResponse {}

export interface TerminateParams {
  processId: ProcessId;
}

export interface TerminateResponse {
  running: boolean;
}

export interface FsReadFileParams {
  path: string;
  sandbox: FileSystemSandboxContext;
}

export interface FsReadFileResponse {
  dataBase64: string;
}

export interface FsWriteFileParams {
  path: string;
  dataBase64: string;
  sandbox: FileSystemSandboxContext;
}

export interface FsWriteFileResponse {}

export interface FsCreateDirectoryParams {
  path: string;
  recursive?: boolean;
  sandbox: FileSystemSandboxContext;
}

export interface FsCreateDirectoryResponse {}

export interface FsGetMetadataParams {
  path: string;
  sandbox: FileSystemSandboxContext;
}

export interface FsGetMetadataResponse {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  createdAtMs: number;
  modifiedAtMs: number;
}

export interface FsReadDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FsReadDirectoryParams {
  path: string;
  sandbox: FileSystemSandboxContext;
}

export interface FsReadDirectoryResponse {
  entries: FsReadDirectoryEntry[];
}

export interface FsWalkParams {
  path: string;
  options: {
    maxDepth: number;
    maxDirectories: number;
    maxEntries: number;
    followDirectorySymlinks: boolean;
    pruneHiddenDirectories?: boolean;
  };
  sandbox: FileSystemSandboxContext;
}

export interface FsWalkResponse {
  entries: Array<{ path: string; kind: "directory" | "file" }>;
  errors: Array<{ path: string; message: string }>;
  truncated: boolean;
}

export interface FsRemoveParams {
  path: string;
  recursive?: boolean;
  force?: boolean;
  sandbox: FileSystemSandboxContext;
}

export interface FsRemoveResponse {}

export interface FsCopyParams {
  sourcePath: string;
  destinationPath: string;
  recursive: boolean;
  sandbox: FileSystemSandboxContext;
}

export interface FsCopyResponse {}

export interface HttpRequestParams {
  method: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
  bodyBase64?: string;
  timeoutMs?: number;
  requestId: string;
  streamResponse?: boolean;
}

export interface HttpRequestResponse {
  status: number;
  headers: Array<{ name: string; value: string }>;
  bodyBase64: string;
}

export interface EnvironmentInfo {
  shell: { name: string; path: string };
  cwd?: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export const METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  processStart: "process/start",
  processRead: "process/read",
  processWrite: "process/write",
  processSignal: "process/signal",
  processTerminate: "process/terminate",
  fsReadFile: "fs/readFile",
  fsWriteFile: "fs/writeFile",
  fsCreateDirectory: "fs/createDirectory",
  fsReadDirectory: "fs/readDirectory",
  fsWalk: "fs/walk",
  fsRemove: "fs/remove",
  fsCopy: "fs/copy",
  fsGetMetadata: "fs/getMetadata",
  httpRequest: "http/request",
  environmentInfo: "environment/info",
  environmentStatus: "environment/status",
} as const;

export const NOTIFICATIONS = {
  processOutput: "process/output",
  processExited: "process/exited",
  processClosed: "process/closed",
  httpBodyDelta: "http/request/bodyDelta",
} as const;
