import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CodexAdapter } from "@codehands/codex-adapter";
import { resolveProcessLaunch, type ProcessLaunchMode, type ResolvedProcessLaunch } from "./process-launch.js";
import { inspectImage } from "./image-inspection.js";
import { runRepositoryQuery, type InternalCommandResult } from "./repository-query.js";

const FILE_LINE_WINDOW_CHARS = 20_000;
const FILE_BYTE_WINDOW_BYTES = 20_000;
const PROCESS_STDOUT_WINDOW_CHARS = 20_000;
const PROCESS_STDERR_WINDOW_CHARS = 10_000;
const PROCESS_RUN_DEFAULT_TIMEOUT_MS = 30_000;
const TOTAL_TOOL_RESPONSE_WINDOW_CHARS = 60_000;
const HTTP_RESPONSE_BODY_WINDOW_BYTES = 60_000;
const PROCESS_RUN_MIN_TIMEOUT_MS = 100;
const PROCESS_RUN_MAX_TIMEOUT_MS = 60_000;
const FILE_BLOCK_BYTES = 64 * 1024;
const PROCESS_READ_BLOCK_BYTES = 64 * 1024;

export interface ProcessInfo {
  command: string;
  argv: string[];
  mode: ProcessLaunchMode;
  tty: boolean;
  startedAt: string;
  exited: boolean;
  exitCode?: number | null;
  sessionId: string;
}

export interface RequestUserInputPrompt {
  message: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required: boolean;
  minLength: number;
  maxLength: number;
}

export interface RequestUserInputResult {
  action: "accept" | "decline" | "cancel";
  value?: string;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolContext {
  adapter: CodexAdapter;
  activeWorkspace: string | null;
  workspaces: string[];
  resolvePath: (relativePath: string) => string;
  ownedProcesses: Map<string, ProcessInfo>;
  sessionId: string;
  checkBlocked?: (argv: string[]) => string | null;
  requestUserInput?: (prompt: RequestUserInputPrompt) => Promise<RequestUserInputResult>;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type JsonObject = Record<string, unknown>;
type HandlerFn = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

type RequestParseResult =
  | { ok: true; requests: JsonObject[] }
  | { ok: false; result: ToolResult };

interface PreparedLaunch {
  command: string;
  args: string[];
  shell: boolean;
  cwd: string;
  tty: boolean;
  launch: ResolvedProcessLaunch;
}

function toFileUri(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}

function textResult(data: JsonObject): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedError(code: string, error: unknown): { code: string; message: string } {
  return { code, message: messageOf(error) };
}

function failureItem(identity: JsonObject, code: string, error: unknown): JsonObject {
  return {
    ...identity,
    success: false,
    error: normalizedError(code, error),
  };
}

function parseRequests(params: Record<string, unknown>): RequestParseResult {
  const raw = params["requests"];
  if (!Array.isArray(raw)) {
    return { ok: false, result: errorResult("This tool requires a 'requests' array containing 1 to 8 items.") };
  }
  if (raw.length < 1 || raw.length > 8) {
    return { ok: false, result: errorResult("'requests' must contain between 1 and 8 items.") };
  }
  if (raw.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    return { ok: false, result: errorResult("Every item in 'requests' must be an object.") };
  }
  return { ok: true, requests: raw as JsonObject[] };
}

async function runConcurrent(
  params: Record<string, unknown>,
  identity: (request: JsonObject) => JsonObject,
  code: string,
  operation: (request: JsonObject, index: number, total: number) => Promise<JsonObject>,
): Promise<ToolResult> {
  const parsed = parseRequests(params);
  if (!parsed.ok) return parsed.result;
  const results = await Promise.all(parsed.requests.map(async (request, index) => {
    try {
      return await operation(request, index, parsed.requests.length);
    } catch (error) {
      return failureItem(identity(request), code, error);
    }
  }));
  return textResult({ results });
}

async function runSequential(
  params: Record<string, unknown>,
  identity: (request: JsonObject) => JsonObject,
  code: string,
  operation: (request: JsonObject, index: number, total: number) => Promise<JsonObject>,
): Promise<ToolResult> {
  const parsed = parseRequests(params);
  if (!parsed.ok) return parsed.result;
  const results: JsonObject[] = [];
  for (let index = 0; index < parsed.requests.length; index += 1) {
    const request = parsed.requests[index]!;
    try {
      results.push(await operation(request, index, parsed.requests.length));
    } catch (error) {
      results.push(failureItem(identity(request), code, error));
    }
  }
  return textResult({ results });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  maxConcurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function pathIdentity(request: JsonObject): JsonObject {
  return { path: String(request["path"] ?? "") };
}

function processIdentity(request: JsonObject): JsonObject {
  return { processId: String(request["processId"] ?? "") };
}

function commandIdentity(request: JsonObject, cwd?: string): JsonObject {
  return {
    command: String(request["command"] ?? ""),
    args: Array.isArray(request["args"]) ? request["args"] : [],
    shell: Boolean(request["shell"]),
    cwd: cwd ?? String(request["cwd"] ?? "."),
  };
}

function requireString(request: JsonObject, name: string): string {
  const value = request[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalInteger(request: JsonObject, name: string, fallback?: number): number | undefined {
  const value = request[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function takeCompleteLine(buffer: string, final: boolean): { line: string; rest: string } | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === "\n") {
      return { line: buffer.slice(0, index + 1), rest: buffer.slice(index + 1) };
    }
    if (char === "\r") {
      if (index + 1 < buffer.length) {
        const end = buffer[index + 1] === "\n" ? index + 2 : index + 1;
        return { line: buffer.slice(0, end), rest: buffer.slice(end) };
      }
      if (final) return { line: buffer, rest: "" };
      return null;
    }
  }
  if (final && buffer.length > 0) return { line: buffer, rest: "" };
  return null;
}

async function readByteWindow(
  adapter: CodexAdapter,
  fileUri: string,
  offset: number,
  maxBytes: number,
): Promise<{ content: string; returnedBytes: number; eof: boolean; nextOffset?: number }> {
  const handleId = uniqueId("file");
  await adapter.fsOpen({ handleId, path: fileUri });
  try {
    const block = await adapter.fsReadBlock({ handleId, offset, len: maxBytes });
    const bytes = Buffer.from(block.chunk, "base64");
    return {
      content: bytes.toString("utf-8"),
      returnedBytes: bytes.length,
      eof: block.eof,
      ...(block.eof ? {} : { nextOffset: offset + bytes.length }),
    };
  } finally {
    await adapter.fsClose({ handleId }).catch(() => undefined);
  }
}

async function readLineWindow(
  adapter: CodexAdapter,
  fileUri: string,
  fromLine: number,
  toLine: number | undefined,
  maxChars: number,
): Promise<{
  content: string;
  fromLine: number;
  toLine: number;
  returnedChars: number;
  eof: boolean;
  nextFromLine?: number;
  totalLines?: number;
}> {
  const handleId = uniqueId("file");
  await adapter.fsOpen({ handleId, path: fileUri });
  const decoder = new StringDecoder("utf8");
  let byteOffset = 0;
  let pending = "";
  let currentLine = 1;
  let lastIncludedLine = fromLine - 1;
  let returnedChars = 0;
  const parts: string[] = [];
  let stopped = false;
  let actualEof = false;
  let nextFromLine: number | undefined;
  let totalLines: number | undefined;
  let oversizedLine: number | undefined;

  const consumeLine = (line: string): void => {
    const lineNumber = currentLine;
    currentLine += 1;
    if (lineNumber < fromLine) return;
    if (toLine !== undefined && lineNumber > toLine) {
      stopped = true;
      nextFromLine = lineNumber;
      return;
    }
    if (parts.length === 0 && line.length > maxChars) {
      oversizedLine = lineNumber;
      stopped = true;
      return;
    }
    if (parts.length > 0 && returnedChars + line.length > maxChars) {
      stopped = true;
      nextFromLine = lineNumber;
      return;
    }
    parts.push(line);
    returnedChars += line.length;
    lastIncludedLine = lineNumber;
    if (toLine !== undefined && lineNumber >= toLine) {
      stopped = true;
      nextFromLine = lineNumber + 1;
    }
  };

  try {
    while (!stopped) {
      const block = await adapter.fsReadBlock({ handleId, offset: byteOffset, len: FILE_BLOCK_BYTES });
      const bytes = Buffer.from(block.chunk, "base64");
      byteOffset += bytes.length;
      pending += decoder.write(bytes);

      while (!stopped) {
        const extracted = takeCompleteLine(pending, false);
        if (!extracted) break;
        pending = extracted.rest;
        consumeLine(extracted.line);
      }

      if (block.eof) {
        pending += decoder.end();
        while (!stopped) {
          const extracted = takeCompleteLine(pending, true);
          if (!extracted) break;
          pending = extracted.rest;
          consumeLine(extracted.line);
        }
        actualEof = !stopped && pending.length === 0;
        if (actualEof) totalLines = currentLine - 1;
        break;
      }
      if (bytes.length === 0) {
        actualEof = true;
        totalLines = currentLine - 1;
        break;
      }
    }
  } finally {
    await adapter.fsClose({ handleId }).catch(() => undefined);
  }

  if (oversizedLine !== undefined) {
    throw new Error(`Line ${oversizedLine} exceeds maxChars; use byte mode with offset/maxBytes to read it safely.`);
  }

  const eof = actualEof;
  return {
    content: parts.join(""),
    fromLine,
    toLine: lastIncludedLine,
    returnedChars,
    eof,
    ...(eof ? {} : { nextFromLine: nextFromLine ?? Math.max(fromLine, lastIncludedLine + 1) }),
    ...(totalLines === undefined ? {} : { totalLines }),
  };
}

async function prepareLaunch(request: JsonObject, ctx: ToolContext): Promise<PreparedLaunch> {
  const command = requireString(request, "command");
  const argsValue = request["args"];
  const args = argsValue === undefined
    ? []
    : Array.isArray(argsValue) && argsValue.every((value) => typeof value === "string")
      ? argsValue as string[]
      : (() => { throw new Error("args must be an array of strings."); })();
  if (typeof request["shell"] !== "boolean") throw new Error("shell must be provided as a boolean.");
  const shell = request["shell"] as boolean;
  if (shell && request["args"] !== undefined) {
    throw new Error("args cannot be used when shell is true; include shell syntax in command instead.");
  }
  const cwd = request["cwd"] !== undefined
    ? ctx.resolvePath(requireString(request, "cwd"))
    : ctx.activeWorkspace ?? undefined;
  if (!cwd) throw new Error("No active workspace. Call workspace_set first or provide cwd.");
  const env = request["env"] as Record<string, string> | undefined;
  const tty = (request["tty"] as boolean | undefined) ?? false;
  const launch = await resolveProcessLaunch({
    adapter: ctx.adapter,
    command,
    args: request["args"] === undefined ? undefined : args,
    shell,
    cwd,
    env,
  });
  const blocked = ctx.checkBlocked?.(launch.policyArgv);
  if (blocked) throw new Error(blocked);
  return { command, args, shell, cwd, tty, launch };
}

async function startPreparedProcess(prepared: PreparedLaunch, ctx: ToolContext): Promise<string> {
  const result = await ctx.adapter.processStart({
    argv: prepared.launch.argv,
    cwd: toFileUri(prepared.cwd),
    envPolicy: {
      inherit: "all",
      ignoreDefaultExcludes: false,
      exclude: [],
      set: {},
      includeOnly: [],
    },
    env: prepared.launch.env,
    tty: prepared.tty,
    pipeStdin: !prepared.tty,
  });
  ctx.ownedProcesses.set(result.processId, {
    command: prepared.launch.displayCommand,
    argv: prepared.launch.policyArgv,
    mode: prepared.launch.mode,
    tty: prepared.tty,
    startedAt: new Date().toISOString(),
    exited: false,
    sessionId: ctx.sessionId,
  });
  return result.processId;
}

function appendProcessChunk(
  stream: "stdout" | "stderr" | "pty",
  text: string,
  stdout: string,
  stderr: string,
  stdoutLimit: number,
  stderrLimit: number,
): {
  accepted: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
} {
  if (stream === "stderr") {
    if (stderr.length + text.length > stderrLimit) {
      return { accepted: false, stdout, stderr, stdoutTruncated: false, stderrTruncated: true };
    }
    return { accepted: true, stdout, stderr: stderr + text, stdoutTruncated: false, stderrTruncated: false };
  }
  if (stdout.length + text.length > stdoutLimit) {
    return { accepted: false, stdout, stderr, stdoutTruncated: true, stderrTruncated: false };
  }
  return { accepted: true, stdout: stdout + text, stderr, stdoutTruncated: false, stderrTruncated: false };
}

async function runOneCommand(request: JsonObject, ctx: ToolContext, totalRequests: number): Promise<JsonObject> {
  if (request["tty"] !== undefined) {
    return failureItem(commandIdentity(request), "PROCESS_RUN_TTY_UNSUPPORTED", "process_run does not support tty; use process_start for interactive work.");
  }
  let prepared: PreparedLaunch;
  try {
    prepared = await prepareLaunch({ ...request, tty: false }, ctx);
  } catch (error) {
    return failureItem(commandIdentity(request), "PROCESS_RUN_LAUNCH_FAILED", error);
  }

  const timeoutMs = optionalInteger(request, "timeoutMs", PROCESS_RUN_DEFAULT_TIMEOUT_MS)!;
  if (timeoutMs < PROCESS_RUN_MIN_TIMEOUT_MS) {
    return failureItem(commandIdentity(request, prepared.cwd), "PROCESS_RUN_TIMEOUT_INVALID", `timeoutMs must be at least ${PROCESS_RUN_MIN_TIMEOUT_MS}.`);
  }
  if (timeoutMs > PROCESS_RUN_MAX_TIMEOUT_MS) {
    return failureItem(
      commandIdentity(request, prepared.cwd),
      "PROCESS_RUN_TIMEOUT_INVALID",
      "process_run is intended for short commands and supports at most 60000 ms. Use process_start for longer-running commands, servers, watchers, or interactive work.",
    );
  }
  const requestedStdoutChars = optionalInteger(request, "maxStdoutChars", PROCESS_STDOUT_WINDOW_CHARS)!;
  const requestedStderrChars = optionalInteger(request, "maxStderrChars", PROCESS_STDERR_WINDOW_CHARS)!;
  const perItemBudget = Math.max(2, Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / totalRequests));
  const stdoutBudget = Math.max(1, Math.floor(perItemBudget * 2 / 3));
  const stderrBudget = Math.max(1, perItemBudget - stdoutBudget);
  const maxStdoutChars = Math.min(requestedStdoutChars, stdoutBudget);
  const maxStderrChars = Math.min(requestedStderrChars, stderrBudget);
  if (requestedStdoutChars < 1 || requestedStdoutChars > PROCESS_STDOUT_WINDOW_CHARS) {
    return failureItem(commandIdentity(request, prepared.cwd), "PROCESS_RUN_OUTPUT_LIMIT_INVALID", `maxStdoutChars must be between 1 and ${PROCESS_STDOUT_WINDOW_CHARS}.`);
  }
  if (requestedStderrChars < 1 || requestedStderrChars > PROCESS_STDERR_WINDOW_CHARS) {
    return failureItem(commandIdentity(request, prepared.cwd), "PROCESS_RUN_OUTPUT_LIMIT_INVALID", `maxStderrChars must be between 1 and ${PROCESS_STDERR_WINDOW_CHARS}.`);
  }

  const startedAt = Date.now();
  let processId: string;
  try {
    processId = await startPreparedProcess(prepared, ctx);
  } catch (error) {
    return failureItem(commandIdentity(request, prepared.cwd), "PROCESS_RUN_START_FAILED", error);
  }

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let inclusionStopped = false;
  let lastIncludedSeq = 0;
  let pollAfterSeq = 0;
  let exitCode: number | null = null;
  let failure: string | null = null;
  let timedOut = false;
  let readFailed = false;
  let closed = false;

  const acceptChunks = (chunks: Array<{ seq: number; stream: "stdout" | "stderr" | "pty"; chunk: string }>): void => {
    for (const chunk of chunks) {
      if (inclusionStopped) continue;
      const text = Buffer.from(chunk.chunk, "base64").toString("utf-8");
      const appended = appendProcessChunk(chunk.stream, text, stdout, stderr, maxStdoutChars, maxStderrChars);
      stdout = appended.stdout;
      stderr = appended.stderr;
      stdoutTruncated ||= appended.stdoutTruncated;
      stderrTruncated ||= appended.stderrTruncated;
      if (!appended.accepted) {
        inclusionStopped = true;
      } else {
        lastIncludedSeq = chunk.seq;
      }
    }
  };

  try {
    while (!closed) {
      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const result = await ctx.adapter.processRead({
        processId,
        afterSeq: pollAfterSeq,
        maxBytes: PROCESS_READ_BLOCK_BYTES,
        waitMs: Math.min(remaining, 250),
      });
      acceptChunks(result.chunks);
      pollAfterSeq = Math.max(pollAfterSeq, Math.max(0, result.nextSeq - 1));
      exitCode = result.exitCode ?? exitCode;
      failure = result.failure ?? failure;
      closed = result.closed;
      const info = ctx.ownedProcesses.get(processId);
      if (info && (result.exited || result.closed)) {
        info.exited = true;
        info.exitCode = result.exitCode ?? null;
      }
    }
  } catch (error) {
    failure = messageOf(error);
    readFailed = true;
  }

  if (readFailed && !timedOut) {
    await ctx.adapter.processTerminate({ processId }).catch(() => undefined);
    const info = ctx.ownedProcesses.get(processId);
    if (info) info.exited = true;
  }

  if (timedOut) {
    await ctx.adapter.processTerminate({ processId }).catch(() => undefined);
    const info = ctx.ownedProcesses.get(processId);
    if (info) info.exited = true;
    try {
      const finalRead = await ctx.adapter.processRead({ processId, afterSeq: pollAfterSeq, maxBytes: PROCESS_READ_BLOCK_BYTES, waitMs: 0 });
      acceptChunks(finalRead.chunks);
      pollAfterSeq = Math.max(pollAfterSeq, Math.max(0, finalRead.nextSeq - 1));
      exitCode = finalRead.exitCode ?? exitCode;
      failure = finalRead.failure ?? failure;
    } catch {
      // The process may already have been evicted; timeout state remains authoritative.
    }
  }

  const durationMs = Date.now() - startedAt;
  const truncated = stdoutTruncated || stderrTruncated;
  const status = timedOut ? "timed_out" : exitCode === 0 && !failure ? "succeeded" : "failed";
  const success = status === "succeeded";
  const result: JsonObject = {
    ...commandIdentity(request, prepared.cwd),
    status,
    success,
    exitCode: exitCode ?? null,
    timedOut,
    durationMs,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
  };
  if (timedOut) {
    result.error = {
      code: "PROCESS_RUN_TIMEOUT",
      message: `Command exceeded the ${timeoutMs} ms process_run timeout and was terminated. Use process_start for long-running work.`,
    };
  } else if (!success) {
    result.error = {
      code: failure ? "PROCESS_RUN_FAILED" : "PROCESS_EXIT_NON_ZERO",
      message: failure ?? `Command exited with code ${exitCode ?? "unknown"}.`,
    };
  }
  if (truncated) {
    result.processId = processId;
    result.nextAfterSeq = lastIncludedSeq;
  } else {
    ctx.ownedProcesses.delete(processId);
  }
  return result;
}

async function runInternalCommand(
  command: string,
  args: string[],
  cwd: string,
  ctx: ToolContext,
  stdin?: string,
  timeoutMs = 30_000,
): Promise<InternalCommandResult> {
  const launch = await resolveProcessLaunch({ adapter: ctx.adapter, command, args, shell: false, cwd });
  const blocked = ctx.checkBlocked?.(launch.policyArgv);
  if (blocked) throw new Error(blocked);
  const startedAt = Date.now();
  const started = await ctx.adapter.processStart({
    argv: launch.argv,
    cwd: toFileUri(cwd),
    envPolicy: {
      inherit: "all",
      ignoreDefaultExcludes: false,
      exclude: [],
      set: {},
      includeOnly: [],
    },
    env: launch.env,
    tty: false,
    pipeStdin: stdin !== undefined,
  });
  if (stdin !== undefined) {
    await ctx.adapter.processWrite({
      processId: started.processId,
      chunk: Buffer.from(stdin, "utf8").toString("base64"),
      writeId: uniqueId("internal-write"),
    });
  }
  let afterSeq = 0;
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let failure: string | null = null;
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      await ctx.adapter.processTerminate({ processId: started.processId }).catch(() => undefined);
      throw new Error(`Internal command exceeded ${timeoutMs} ms and was terminated.`);
    }
    const result = await ctx.adapter.processRead({
      processId: started.processId,
      afterSeq,
      maxBytes: PROCESS_READ_BLOCK_BYTES,
      waitMs: Math.min(250, timeoutMs - elapsed),
    });
    for (const chunk of result.chunks) {
      const text = Buffer.from(chunk.chunk, "base64").toString("utf8");
      if (chunk.stream === "stderr") stderr += text;
      else stdout += text;
    }
    if (stdout.length + stderr.length > 2_000_000) {
      await ctx.adapter.processTerminate({ processId: started.processId }).catch(() => undefined);
      throw new Error("Internal command output exceeded 2,000,000 characters.");
    }
    afterSeq = Math.max(afterSeq, Math.max(0, result.nextSeq - 1));
    exitCode = result.exitCode ?? exitCode;
    failure = result.failure ?? failure;
    if (result.closed) break;
  }
  return {
    exitCode: failure && exitCode === 0 ? 1 : exitCode,
    stdout,
    stderr: failure ? `${stderr}${stderr ? "\n" : ""}${failure}` : stderr,
  };
}

async function readAllFileBytes(ctx: ToolContext, fsPath: string, maxBytes: number): Promise<Buffer> {
  const metadata = await ctx.adapter.fsGetMetadata({ path: toFileUri(fsPath) });
  if (!metadata.isFile || metadata.isDirectory) throw new Error("Path is not a regular file.");
  if (metadata.size > maxBytes) throw new Error(`File is ${metadata.size} bytes; maximum supported size is ${maxBytes} bytes.`);
  const handleId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await ctx.adapter.fsOpen({ handleId, path: toFileUri(fsPath) });
  const chunks: Buffer[] = [];
  let offset = 0;
  try {
    while (true) {
      const block = await ctx.adapter.fsReadBlock({
        handleId,
        offset,
        len: Math.min(FILE_BLOCK_BYTES, maxBytes - offset + 1),
      });
      const bytes = Buffer.from(block.chunk, "base64");
      chunks.push(bytes);
      offset += bytes.length;
      if (offset > maxBytes) throw new Error(`File exceeds maximum supported size of ${maxBytes} bytes.`);
      if (block.eof) break;
      if (bytes.length === 0) throw new Error("File read stopped before EOF.");
    }
  } finally {
    await ctx.adapter.fsClose({ handleId }).catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function stringOption(params: JsonObject, name: string, fallback: string, maxLength: number): string {
  const value = params[name] ?? fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  if (value.length > maxLength) throw new Error(`${name} must contain at most ${maxLength} characters.`);
  return value;
}

function patchHelperExecutable(): string {
  const filename = process.platform === "win32" ? "codehands-apply-patch.exe" : "codehands-apply-patch";
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../native/codehands-apply-patch/bin",
    filename,
  );
}

function rejectSecretPrompt(values: string[]): void {
  const text = values.join(" ");
  if (/password|passcode|api[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|secret|private[\s_-]?key|credit[\s_-]?card|payment|\bcvv\b/i.test(text)) {
    throw new Error("request_user_input cannot be used to request secrets, credentials, payment data, or private keys.");
  }
}

const handlers: Record<string, HandlerFn> = {
  async fs_readFile(params, ctx) {
    return runConcurrent(params, pathIdentity, "FS_READ_FAILED", async (request, _index, total) => {
      const requestedPath = requireString(request, "path");
      const fsPath = ctx.resolvePath(requestedPath);
      const lineFieldsPresent = request["fromLine"] !== undefined || request["toLine"] !== undefined || request["maxChars"] !== undefined;
      const byteFieldsPresent = request["offset"] !== undefined || request["maxBytes"] !== undefined;
      if (lineFieldsPresent && byteFieldsPresent) {
        throw new Error("Line fields and byte fields cannot be combined in the same read request.");
      }
      if (byteFieldsPresent) {
        const offset = optionalInteger(request, "offset", 0)!;
        const requestedMaxBytes = optionalInteger(request, "maxBytes", FILE_BYTE_WINDOW_BYTES)!;
        const maxBytes = Math.min(requestedMaxBytes, Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / total));
        if (offset < 0) throw new Error("offset must be at least 0.");
        if (requestedMaxBytes < 1 || requestedMaxBytes > FILE_BYTE_WINDOW_BYTES) {
          throw new Error(`maxBytes must be between 1 and ${FILE_BYTE_WINDOW_BYTES}.`);
        }
        const data = await readByteWindow(ctx.adapter, toFileUri(fsPath), offset, maxBytes);
        return { path: fsPath, success: true, mode: "byte", offset, ...data };
      }
      const fromLine = optionalInteger(request, "fromLine", 1)!;
      const toLine = optionalInteger(request, "toLine");
      const requestedMaxChars = optionalInteger(request, "maxChars", FILE_LINE_WINDOW_CHARS)!;
      const maxChars = Math.min(requestedMaxChars, Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / total));
      if (fromLine < 1) throw new Error("fromLine must be at least 1.");
      if (toLine !== undefined && toLine < fromLine) throw new Error("toLine must be greater than or equal to fromLine.");
      if (requestedMaxChars < 1 || requestedMaxChars > FILE_LINE_WINDOW_CHARS) {
        throw new Error(`maxChars must be between 1 and ${FILE_LINE_WINDOW_CHARS}.`);
      }
      const data = await readLineWindow(ctx.adapter, toFileUri(fsPath), fromLine, toLine, maxChars);
      return { path: fsPath, success: true, mode: "line", ...data };
    });
  },

  async fs_writeFile(params, ctx) {
    return runSequential(params, pathIdentity, "FS_WRITE_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      const contentValue = request["content"];
      if (typeof contentValue !== "string") throw new Error("content must be a string.");
      const content = contentValue;
      const dataBase64 = Buffer.from(content, "utf-8").toString("base64");
      await ctx.adapter.fsWriteFile({ path: toFileUri(fsPath), dataBase64 });
      return { path: fsPath, success: true, written: true, bytes: Buffer.byteLength(content, "utf-8") };
    });
  },

  async fs_createDirectory(params, ctx) {
    return runSequential(params, pathIdentity, "FS_CREATE_DIRECTORY_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      const recursive = (request["recursive"] as boolean | undefined) ?? true;
      await ctx.adapter.fsCreateDirectory({ path: toFileUri(fsPath), recursive });
      return { path: fsPath, success: true, created: true };
    });
  },

  async fs_readDirectory(params, ctx) {
    return runConcurrent(params, pathIdentity, "FS_READ_DIRECTORY_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      const result = await ctx.adapter.fsReadDirectory({ path: toFileUri(fsPath) });
      return { path: fsPath, success: true, entries: result.entries };
    });
  },

  async fs_walk(params, ctx) {
    return runConcurrent(params, pathIdentity, "FS_WALK_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      const options: Record<string, unknown> = {
        maxDepth: optionalInteger(request, "maxDepth", 8),
        maxDirectories: 10_000,
        maxEntries: 50_000,
        followDirectorySymlinks: (request["followDirectorySymlinks"] as boolean | undefined) ?? false,
      };
      const data = await ctx.adapter.fsWalk({ path: toFileUri(fsPath), options });
      return { path: fsPath, success: true, data };
    });
  },

  async fs_remove(params, ctx) {
    return runSequential(params, pathIdentity, "FS_REMOVE_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      await ctx.adapter.fsRemove({
        path: toFileUri(fsPath),
        recursive: (request["recursive"] as boolean | undefined) ?? false,
        force: (request["force"] as boolean | undefined) ?? false,
      });
      return { path: fsPath, success: true, removed: true };
    });
  },

  async fs_copy(params, ctx) {
    return runSequential(params, (request) => ({
      sourcePath: String(request["sourcePath"] ?? ""),
      destinationPath: String(request["destinationPath"] ?? ""),
    }), "FS_COPY_FAILED", async (request) => {
      const sourcePath = ctx.resolvePath(requireString(request, "sourcePath"));
      const destinationPath = ctx.resolvePath(requireString(request, "destinationPath"));
      await ctx.adapter.fsCopy({
        sourcePath: toFileUri(sourcePath),
        destinationPath: toFileUri(destinationPath),
        recursive: (request["recursive"] as boolean | undefined) ?? false,
      });
      return { sourcePath, destinationPath, success: true, copied: true };
    });
  },

  async fs_getMetadata(params, ctx) {
    return runConcurrent(params, pathIdentity, "FS_METADATA_FAILED", async (request) => {
      const fsPath = ctx.resolvePath(requireString(request, "path"));
      const result = await ctx.adapter.fsGetMetadata({ path: toFileUri(fsPath) });
      return { path: fsPath, success: true, ...result };
    });
  },

  async fs_applyPatch(params, ctx) {
    const patch = params["patch"];
    if (typeof patch !== "string" || patch.length === 0) return errorResult("patch must be a non-empty string.");
    if (Buffer.byteLength(patch, "utf8") > 200_000) return errorResult("patch exceeds the 200000-byte limit.");
    const cwd = ctx.resolvePath(typeof params["cwd"] === "string" ? params["cwd"] as string : ".");
    const dryRun = (params["dryRun"] as boolean | undefined) ?? false;
    const allowOverwrite = (params["allowOverwrite"] as boolean | undefined) ?? false;
    const preserveLineEndings = (params["preserveLineEndings"] as boolean | undefined) ?? true;
    const maxFiles = optionalInteger(params, "maxFiles", 50)!;
    if (typeof dryRun !== "boolean" || typeof allowOverwrite !== "boolean" || typeof preserveLineEndings !== "boolean") {
      return errorResult("dryRun, allowOverwrite, and preserveLineEndings must be booleans.");
    }
    if (maxFiles < 1 || maxFiles > 100) return errorResult("maxFiles must be between 1 and 100.");
    try {
      const request = {
        version: 1,
        patch,
        cwd,
        workspaceRoots: ctx.workspaces,
        dryRun,
        allowOverwrite,
        preserveLineEndings,
        maxFiles,
      };
      const result = await runInternalCommand(
        patchHelperExecutable(),
        [],
        cwd,
        ctx,
        JSON.stringify(request) + "\n",
        60_000,
      );
      const output = result.stdout.trim();
      if (!output) throw new Error(result.stderr.trim() || "Patch helper returned no structured result.");
      const data = JSON.parse(output) as JsonObject;
      if (typeof data["success"] !== "boolean" || !Array.isArray(data["changes"])) {
        throw new Error("Patch helper returned an invalid result shape.");
      }
      const response = textResult(data);
      if (data["success"] === false) response.isError = true;
      return response;
    } catch (error) {
      return errorResult(`fs_applyPatch failed: ${messageOf(error)}. Build the native helper with pnpm build:patch-helper.`);
    }
  },

  async repo_query(params, ctx) {
    try {
      const data = await runRepositoryQuery(params, {
        activeWorkspace: ctx.activeWorkspace,
        resolvePath: ctx.resolvePath,
        runGit: (args, cwd) => runInternalCommand("git", args, cwd, ctx),
      });
      return textResult(data);
    } catch (error) {
      return errorResult(`repo_query failed: ${messageOf(error)}`);
    }
  },

  async view_image(params, ctx) {
    const requestedPath = requireString(params, "path");
    const fsPath = ctx.resolvePath(requestedPath);
    try {
      const bytes = await readAllFileBytes(ctx, fsPath, 10 * 1024 * 1024);
      const info = inspectImage(bytes);
      const metadata = {
        path: fsPath,
        success: true,
        mimeType: info.mimeType,
        bytes: bytes.length,
        width: info.width,
        height: info.height,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(metadata, null, 2) },
          { type: "image", data: bytes.toString("base64"), mimeType: info.mimeType },
        ],
        structuredContent: metadata,
      };
    } catch (error) {
      return errorResult(`view_image failed: ${messageOf(error)}`);
    }
  },

  async process_run(params, ctx) {
    const parsed = parseRequests(params);
    if (!parsed.ok) return parsed.result;
    const execution = (params["execution"] as string | undefined) ?? "sequential";
    if (execution !== "sequential" && execution !== "parallel") {
      return errorResult("execution must be 'sequential' or 'parallel'.");
    }
    const requestedConcurrency = optionalInteger(params as JsonObject, "maxConcurrency", 3)!;
    if (requestedConcurrency < 1 || requestedConcurrency > 3) {
      return errorResult("maxConcurrency must be between 1 and 3.");
    }
    const results = execution === "parallel"
      ? await mapWithConcurrency(parsed.requests, requestedConcurrency, (request) => runOneCommand(request, ctx, parsed.requests.length))
      : await (async () => {
          const values: JsonObject[] = [];
          for (const request of parsed.requests) values.push(await runOneCommand(request, ctx, parsed.requests.length));
          return values;
        })();
    return textResult({ results });
  },

  async process_start(params, ctx) {
    return runSequential(params, (request) => commandIdentity(request), "PROCESS_START_FAILED", async (request) => {
      const prepared = await prepareLaunch(request, ctx);
      const processId = await startPreparedProcess(prepared, ctx);
      return {
        ...commandIdentity(request, prepared.cwd),
        success: true,
        processId,
        started: true,
        mode: prepared.launch.mode,
        argv: prepared.launch.policyArgv,
        ...(prepared.launch.shellInfo ? { shellInfo: prepared.launch.shellInfo } : {}),
      };
    });
  },

  async process_read(params, ctx) {
    return runConcurrent(params, processIdentity, "PROCESS_READ_FAILED", async (request, _index, total) => {
      const processId = requireString(request, "processId");
      if (!ctx.ownedProcesses.has(processId)) {
        throw new Error(`Process "${processId}" not found. Use process_list to see active processes.`);
      }
      const requestedMaxBytes = optionalInteger(
        request,
        "maxBytes",
        Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / total),
      )!;
      if (requestedMaxBytes < 1 || requestedMaxBytes > TOTAL_TOOL_RESPONSE_WINDOW_CHARS) {
        throw new Error(`maxBytes must be between 1 and ${TOTAL_TOOL_RESPONSE_WINDOW_CHARS}.`);
      }
      const result = await ctx.adapter.processRead({
        processId,
        afterSeq: optionalInteger(request, "afterSeq"),
        maxBytes: Math.min(requestedMaxBytes, Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / total)),
        waitMs: optionalInteger(request, "waitMs"),
      });
      const info = ctx.ownedProcesses.get(processId);
      if (info && (result.exited || result.closed)) {
        info.exited = true;
        info.exitCode = result.exitCode ?? null;
      }
      return {
        processId,
        success: true,
        chunks: result.chunks.map((chunk) => ({
          seq: chunk.seq,
          stream: chunk.stream,
          text: Buffer.from(chunk.chunk, "base64").toString("utf-8"),
        })),
        nextAfterSeq: Math.max(0, result.nextSeq - 1),
        exited: result.exited,
        exitCode: result.exitCode ?? null,
        closed: result.closed,
        failure: result.failure ?? null,
        sandboxDenied: result.sandboxDenied ?? false,
      };
    });
  },

  async process_write(params, ctx) {
    return runSequential(params, processIdentity, "PROCESS_WRITE_FAILED", async (request) => {
      const processId = requireString(request, "processId");
      if (!ctx.ownedProcesses.has(processId)) {
        throw new Error(`Process "${processId}" not found. Use process_list to see active processes.`);
      }
      const input = request["input"];
      if (typeof input !== "string") throw new Error("input must be a string.");
      const result = await ctx.adapter.processWrite({
        processId,
        chunk: Buffer.from(input, "utf-8").toString("base64"),
        writeId: uniqueId("write"),
      });
      if (result.status !== "accepted") {
        return {
          processId,
          success: false,
          status: result.status,
          error: { code: "PROCESS_WRITE_REJECTED", message: `Process input was not accepted: ${result.status}.` },
        };
      }
      return { processId, success: true, status: result.status };
    });
  },

  async process_signal(params, ctx) {
    return runSequential(params, processIdentity, "PROCESS_SIGNAL_FAILED", async (request) => {
      const processId = requireString(request, "processId");
      if (!ctx.ownedProcesses.has(processId)) {
        throw new Error(`Process "${processId}" not found. Use process_list to see active processes.`);
      }
      const signal = (request["signal"] as "interrupt" | undefined) ?? "interrupt";
      try {
        await ctx.adapter.processSignal({ processId, signal });
      } catch (error) {
        const message = messageOf(error);
        throw new Error(process.platform === "win32" && /not supported/i.test(message)
          ? `${message}. This Windows process backend does not support interrupt; use process_terminate.`
          : message);
      }
      return { processId, success: true, signalSent: signal };
    });
  },

  async process_terminate(params, ctx) {
    return runSequential(params, processIdentity, "PROCESS_TERMINATE_FAILED", async (request) => {
      const processId = requireString(request, "processId");
      if (!ctx.ownedProcesses.has(processId)) {
        throw new Error(`Process "${processId}" not found. Use process_list to see active processes.`);
      }
      const result = await ctx.adapter.processTerminate({ processId });
      const info = ctx.ownedProcesses.get(processId);
      if (info) info.exited = true;
      return { processId, success: true, wasRunning: result.running };
    });
  },

  async http_request(params, ctx) {
    return runSequential(params, (request) => ({
      method: String(request["method"] ?? ""),
      url: String(request["url"] ?? ""),
    }), "HTTP_REQUEST_FAILED", async (request, index, total) => {
      const method = requireString(request, "method");
      const url = requireString(request, "url");
      const headersObject = request["headers"] as Record<string, string> | undefined;
      const body = request["body"] as string | undefined;
      const requestedMaxResponseBytes = optionalInteger(request, "maxResponseBytes", HTTP_RESPONSE_BODY_WINDOW_BYTES)!;
      if (requestedMaxResponseBytes < 1 || requestedMaxResponseBytes > HTTP_RESPONSE_BODY_WINDOW_BYTES) {
        throw new Error(`maxResponseBytes must be between 1 and ${HTTP_RESPONSE_BODY_WINDOW_BYTES}.`);
      }
      const result = await ctx.adapter.httpRequest({
        method,
        url,
        headers: headersObject ? Object.entries(headersObject).map(([name, value]) => ({ name, value })) : undefined,
        bodyBase64: body === undefined ? undefined : Buffer.from(body, "utf-8").toString("base64"),
        timeoutMs: optionalInteger(request, "timeoutMs"),
        requestId: uniqueId(`http-${index}`),
      });
      const responseHeaders: Record<string, string> = {};
      for (const header of result.headers) responseHeaders[header.name] = header.value;
      const rawBody = Buffer.from(result.bodyBase64, "base64");
      const effectiveMaxResponseBytes = Math.min(
        requestedMaxResponseBytes,
        Math.floor(TOTAL_TOOL_RESPONSE_WINDOW_CHARS / total),
      );
      const returnedBody = rawBody.subarray(0, effectiveMaxResponseBytes);
      const bodyDecoder = new StringDecoder("utf8");
      return {
        method,
        url,
        success: true,
        status: result.status,
        headers: responseHeaders,
        body: bodyDecoder.write(returnedBody),
        returnedBytes: returnedBody.length,
        totalBytes: rawBody.length,
        bodyTruncated: returnedBody.length < rawBody.length,
      };
    });
  },

  async workspace_list(_params, ctx) {
    return textResult({ workspaces: ctx.workspaces, activeWorkspace: ctx.activeWorkspace });
  },

  async workspace_set(params, ctx) {
    const workspace = params["workspace"] as string;
    const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
    const normalizedInput = normalize(workspace);
    const found = ctx.workspaces.find((candidate) => {
      const normalized = normalize(candidate);
      return normalized === normalizedInput
        || normalized.endsWith(`/${normalizedInput}`)
        || normalizedInput.endsWith(`/${normalized.split("/").pop()!}`);
    });
    if (!found) return errorResult(`Workspace not found: "${workspace}". Use workspace_list to see approved workspaces.`);
    ctx.activeWorkspace = found;
    return textResult({ activeWorkspace: found, set: true });
  },

  async request_user_input(params, ctx) {
    if (!ctx.requestUserInput) return errorResult("request_user_input is unavailable because this MCP client does not support form elicitation.");
    const message = requireString(params, "message");
    if (message.length > 4000) return errorResult("message must contain at most 4000 characters.");
    const label = stringOption(params, "label", "Response", 200);
    const placeholder = params["placeholder"] === undefined ? undefined : stringOption(params, "placeholder", "", 500);
    const defaultValue = params["defaultValue"] === undefined ? undefined : stringOption(params, "defaultValue", "", 20_000);
    const required = (params["required"] as boolean | undefined) ?? true;
    if (typeof required !== "boolean") return errorResult("required must be a boolean.");
    const minLength = optionalInteger(params, "minLength", 0)!;
    const maxLength = optionalInteger(params, "maxLength", 20_000)!;
    if (minLength < 0 || minLength > 20_000) return errorResult("minLength must be between 0 and 20000.");
    if (maxLength < 1 || maxLength > 20_000) return errorResult("maxLength must be between 1 and 20000.");
    if (minLength > maxLength) return errorResult("minLength cannot exceed maxLength.");
    if (defaultValue !== undefined && (defaultValue.length < minLength || defaultValue.length > maxLength)) {
      return errorResult("defaultValue must satisfy minLength and maxLength.");
    }
    try {
      rejectSecretPrompt([message, label, placeholder ?? ""]);
      const result = await ctx.requestUserInput({
        message,
        label,
        ...(placeholder === undefined ? {} : { placeholder }),
        ...(defaultValue === undefined ? {} : { defaultValue }),
        required,
        minLength,
        maxLength,
      });
      if (result.action !== "accept") return textResult({ action: result.action });
      const value = result.value;
      if (typeof value !== "string") return errorResult("The client accepted the form without returning a string value.");
      if ((required && value.length === 0) || value.length < minLength || value.length > maxLength) {
        return errorResult("The returned value does not satisfy the requested validation constraints.");
      }
      return textResult({ action: "accept", value });
    } catch (error) {
      return errorResult(`request_user_input failed: ${messageOf(error)}`);
    }
  },

  async wait(params) {
    const ms = Math.max(0, Math.min(30_000, (params["ms"] as number) ?? 1000));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return textResult({ waited: ms });
  },

  async process_list(_params, ctx) {
    await Promise.all(Array.from(ctx.ownedProcesses.entries()).map(async ([processId, info]) => {
      if (info.exited) return;
      try {
        const status = await ctx.adapter.processRead({ processId, maxBytes: 1, waitMs: 0 });
        if (status.exited || status.closed) {
          info.exited = true;
          info.exitCode = status.exitCode ?? null;
        }
      } catch (error) {
        if (/unknown process/i.test(messageOf(error))) info.exited = true;
      }
    }));
    const completed = Array.from(ctx.ownedProcesses.entries())
      .filter(([, info]) => info.exited)
      .sort((left, right) => left[1].startedAt.localeCompare(right[1].startedAt));
    for (const [processId] of completed.slice(0, Math.max(0, completed.length - 100))) {
      ctx.ownedProcesses.delete(processId);
    }
    const processes = Array.from(ctx.ownedProcesses.entries()).map(([processId, info]) => ({
      processId,
      command: info.command,
      startedAt: info.startedAt,
      status: info.exited ? "exited" : "running",
      exitCode: info.exitCode ?? null,
      mode: info.mode,
      tty: info.tty,
      argv: info.argv,
    }));
    return textResult({ processes, total: processes.length });
  },

  async batch(params, ctx) {
    const rawCalls = params["calls"] as Array<{ tool: string; args: string | Record<string, unknown> }>;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return errorResult("batch requires a non-empty 'calls' array");
    if (rawCalls.length > 20) return errorResult("batch limited to 20 calls per request");
    const results = await Promise.all(rawCalls.map(async (call, index) => {
      const callStartedAt = Date.now();
      const finish = (result: JsonObject): JsonObject => ({
        ...result,
        durationMs: Date.now() - callStartedAt,
      });
      const handler = handlers[call.tool];
      if (!handler) return finish({ index, tool: call.tool, success: false, error: `Unknown tool: ${call.tool}` });
      if (call.tool === "batch") return finish({ index, tool: call.tool, success: false, error: "Cannot nest batch calls" });
      if (call.tool === "request_user_input") return finish({ index, tool: call.tool, success: false, error: "request_user_input cannot run inside batch" });
      if (call.tool === "view_image") return finish({ index, tool: call.tool, success: false, error: "view_image cannot run inside batch because image content cannot be nested" });
      if (call.tool === "workspace_set") {
        return finish({ index, tool: call.tool, success: false, error: "workspace_set cannot run inside a parallel batch; call it separately" });
      }
      let parsedArgs: Record<string, unknown>;
      if (typeof call.args === "string") {
        try {
          parsedArgs = JSON.parse(call.args) as Record<string, unknown>;
        } catch {
          return finish({ index, tool: call.tool, success: false, error: "Invalid JSON in args" });
        }
      } else {
        parsedArgs = call.args ?? {};
      }
      try {
        const result = await handler(parsedArgs, ctx);
        const data = result.structuredContent ?? (() => {
          const text = result.content.find((item) => item.type === "text")?.text ?? "";
          try { return JSON.parse(text); } catch { return text; }
        })();
        return finish({ index, tool: call.tool, success: !result.isError, data });
      } catch (error) {
        return finish({ index, tool: call.tool, success: false, error: messageOf(error) });
      }
    }));
    return textResult({ results, total: results.length });
  },
};

export function getHandler(toolName: string): HandlerFn | undefined {
  return handlers[toolName];
}

export function getAllHandlerNames(): string[] {
  return Object.keys(handlers);
}
