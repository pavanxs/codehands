import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { CodexAdapter } from "@codehands/codex-adapter";
import { validateCommandPaths } from "@codehands/policy-engine";
import { boundedText, clampOutputBytes, type OutputMetadata } from "./output.js";
import type { ProcessRegistry } from "./process-registry.js";

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
export const MAX_PROCESS_TIMEOUT_MS = 10 * 60_000;

export interface DirectCommandOptions {
  adapter: CodexAdapter;
  registry: ProcessRegistry;
  sessionId: string;
  command: string;
  args?: string[];
  cwd: string;
  workspace: string;
  env?: Record<string, string>;
  tty?: boolean;
  pipeStdin?: boolean;
  nonPathArgumentIndexes?: number[];
}

export function baseEnvironment(customEnv?: Record<string, string>): Record<string, string> {
  const isWindows = os.platform() === "win32";
  const result: Record<string, string> = {};
  const keys = isWindows
    ? ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "SHELL"];
  for (const key of keys) if (process.env[key]) result[key] = process.env[key]!;
  return { ...result, ...customEnv };
}

export async function startDirectCommand(options: DirectCommandOptions): Promise<string> {
  const argv = [options.command, ...(options.args ?? [])];
  const confinement = validateCommandPaths({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    workspace: options.workspace,
    nonPathArgumentIndexes: options.nonPathArgumentIndexes,
  });
  if (!confinement.allowed) throw new Error(confinement.reason);
  const result = await options.adapter.processStart({
    argv,
    cwd: pathToFileURL(options.cwd).href,
    env: baseEnvironment(options.env),
    tty: options.tty ?? false,
    pipeStdin: options.pipeStdin,
  });
  options.registry.add(result.processId, {
    command: argv.join(" "),
    argv,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    status: "running",
    sessionId: options.sessionId,
    generation: options.adapter.getGeneration(),
  });
  return result.processId;
}

export interface RunCommandResult {
  processId: string;
  exitCode?: number;
  exited: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: OutputMetadata;
  stdoutOutput: OutputMetadata;
  stderrOutput: OutputMetadata;
  durationMs: number;
}

function metadata(returned: string, totalBytes: number, totalChars: number): OutputMetadata {
  const bytesReturned = Buffer.byteLength(returned, "utf8");
  return {
    truncated: totalBytes > bytesReturned,
    bytesReturned,
    charsReturned: returned.length,
    totalBytes,
    totalChars,
  };
}

export async function runDirectCommand(
  options: DirectCommandOptions & { timeoutMs?: number; maxOutputBytes?: number },
): Promise<RunCommandResult> {
  const timeoutMs = Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, Math.floor(options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)));
  const maxOutputBytes = clampOutputBytes(options.maxOutputBytes);
  const processId = await startDirectCommand(options);
  const started = Date.now();
  let nextSeq = 0;
  let stdout = "";
  let stderr = "";
  let observedBytes = 0;
  let observedChars = 0;
  let stdoutBytes = 0;
  let stdoutChars = 0;
  let stderrBytes = 0;
  let stderrChars = 0;
  let exited = false;
  let exitCode: number | undefined;
  let timedOut = false;

  while (!exited) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const response = await options.adapter.processRead({
      processId,
      afterSeq: nextSeq,
      maxBytes: Math.min(64 * 1024, maxOutputBytes),
      waitMs: Math.min(1000, remaining),
    });
    nextSeq = response.nextSeq;
    let recent = "";
    for (const chunk of response.chunks) {
      const decoded = Buffer.from(chunk.chunk, "base64").toString("utf8");
      const decodedBytes = Buffer.byteLength(decoded, "utf8");
      observedBytes += decodedBytes;
      observedChars += decoded.length;
      if (chunk.stream === "stderr") {
        stderrBytes += decodedBytes;
        stderrChars += decoded.length;
      } else {
        stdoutBytes += decodedBytes;
        stdoutChars += decoded.length;
      }
      recent += decoded;
      const remainingOutputBytes = maxOutputBytes - Buffer.byteLength(stdout + stderr, "utf8");
      if (remainingOutputBytes > 0) {
        const kept = boundedText(decoded, remainingOutputBytes, false).text;
        if (chunk.stream === "stderr") stderr += kept;
        else stdout += kept;
      }
    }
    options.registry.updateFromRead(processId, response, recent);
    exited = response.exited || response.closed;
    exitCode = response.exitCode;
  }

  if (timedOut) {
    try {
      await options.adapter.processTerminate({ processId });
    } finally {
      options.registry.markTerminal(processId, "terminated");
    }
  }

  return {
    processId,
    exitCode,
    exited,
    timedOut,
    stdout,
    stderr,
    output: metadata(stdout + stderr, observedBytes, observedChars),
    stdoutOutput: metadata(stdout, stdoutBytes, stdoutChars),
    stderrOutput: metadata(stderr, stderrBytes, stderrChars),
    durationMs: Date.now() - started,
  };
}
