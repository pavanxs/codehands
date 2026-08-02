import { pathToFileURL } from "node:url";
import { shellArgv } from "@codehands/policy-engine";
import type { ToolContext } from "./context.js";
import { boundedText, clampOutputBytes } from "./output.js";
import { runDirectCommand, startDirectCommand } from "./process-runtime.js";
import {
  fsApplyPatch,
  fsReadRange,
  fsSearch,
  gitDiffSummary,
  repoSnapshot,
  testRun,
} from "./repository-tools.js";
import {
  agentCancel,
  agentResults,
  agentRunMany,
  agentStart,
  agentStatusTool,
} from "./agent-supervisor.js";

export type { ToolContext, TestCommandSpec } from "./context.js";
export type { ProcessInfo, ProcessStatus } from "./process-registry.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type HandlerFn = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

function toFileUri(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function activeCwd(params: Record<string, unknown>, ctx: ToolContext): string | undefined {
  return params["cwd"] ? ctx.resolvePath(params["cwd"] as string) : ctx.activeWorkspace ?? undefined;
}

function activeWorkspace(ctx: ToolContext): string {
  if (!ctx.activeWorkspace) throw new Error("No active workspace. Call workspace_set first.");
  return ctx.activeWorkspace;
}

function checkCommand(ctx: ToolContext, command: string, args: string[]): string | null {
  if (!command) return "command must not be empty";
  return ctx.checkBlocked?.(command, args) ?? null;
}

function chunksToStreams(
  chunks: Array<{ stream: string; chunk: string }>,
  maxBytes: number,
): {
  stdout: string;
  stderr: string;
  combined: string;
  outputMetadata: ReturnType<typeof boundedText>["output"];
  stdoutMetadata: ReturnType<typeof boundedText>["output"];
  stderrMetadata: ReturnType<typeof boundedText>["output"];
} {
  let stdout = "";
  let stderr = "";
  let combined = "";
  let totalBytes = 0;
  let totalChars = 0;
  let stdoutBytes = 0;
  let stdoutChars = 0;
  let stderrBytes = 0;
  let stderrChars = 0;
  for (const chunk of chunks) {
    const decoded = Buffer.from(chunk.chunk, "base64").toString("utf8");
    const bytes = Buffer.byteLength(decoded, "utf8");
    totalBytes += bytes;
    totalChars += decoded.length;
    if (chunk.stream === "stderr") {
      stderrBytes += bytes;
      stderrChars += decoded.length;
    } else {
      stdoutBytes += bytes;
      stdoutChars += decoded.length;
    }
    const remaining = maxBytes - Buffer.byteLength(combined, "utf8");
    if (remaining <= 0) continue;
    const kept = boundedText(decoded, remaining, false).text;
    combined += kept;
    if (chunk.stream === "stderr") stderr += kept;
    else stdout += kept;
  }
  const makeMetadata = (value: string, knownBytes: number, knownChars: number) => ({
    truncated: knownBytes > Buffer.byteLength(value, "utf8"),
    bytesReturned: Buffer.byteLength(value, "utf8"),
    charsReturned: value.length,
    totalBytes: knownBytes,
    totalChars: knownChars,
  });
  return {
    stdout,
    stderr,
    combined,
    outputMetadata: makeMetadata(combined, totalBytes, totalChars),
    stdoutMetadata: makeMetadata(stdout, stdoutBytes, stdoutChars),
    stderrMetadata: makeMetadata(stderr, stderrBytes, stderrChars),
  };
}

const handlers: Record<string, HandlerFn> = {
  async fs_readFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsReadFile({ path: toFileUri(fsPath) });
    const text = Buffer.from(result.dataBase64, "base64").toString("utf8");
    const bounded = boundedText(text, params["maxOutputBytes"] as number | undefined);
    return textResult({ path: fsPath, content: bounded.text, output: bounded.output });
  },

  async fs_writeFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const content = params["content"] as string;
    await ctx.adapter.fsWriteFile({ path: toFileUri(fsPath), dataBase64: Buffer.from(content, "utf8").toString("base64") });
    return textResult({ path: fsPath, written: true, bytes: Buffer.byteLength(content, "utf8") });
  },

  async fs_createDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    await ctx.adapter.fsCreateDirectory({ path: toFileUri(fsPath), recursive: (params["recursive"] as boolean | undefined) ?? true });
    return textResult({ path: fsPath, created: true });
  },

  async fs_readDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsReadDirectory({ path: toFileUri(fsPath) });
    const offset = Math.max(0, Math.floor((params["offset"] as number | undefined) ?? 0));
    const limit = Math.max(1, Math.min(1000, Math.floor((params["limit"] as number | undefined) ?? 200)));
    const entries = result.entries.slice(offset, offset + limit);
    return textResult({ path: fsPath, entries, total: result.entries.length, offset, limit, hasMore: offset + entries.length < result.entries.length });
  },

  async fs_walk(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const options: Record<string, unknown> = {
      maxDepth: (params["maxDepth"] as number | undefined) ?? 8,
      maxDirectories: Math.min(10_000, (params["maxDirectories"] as number | undefined) ?? 2_000),
      maxEntries: Math.min(50_000, (params["maxEntries"] as number | undefined) ?? 10_000),
      followDirectorySymlinks: (params["followDirectorySymlinks"] as boolean | undefined) ?? false,
    };
    const result = await ctx.adapter.fsWalk({ path: toFileUri(fsPath), options });
    const serialized = JSON.stringify(result);
    const bounded = boundedText(serialized, params["maxOutputBytes"] as number | undefined);
    return textResult({ path: fsPath, result: bounded.output.truncated ? bounded.text : result, output: bounded.output });
  },

  async fs_remove(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    await ctx.adapter.fsRemove({
      path: toFileUri(fsPath),
      recursive: (params["recursive"] as boolean | undefined) ?? false,
      force: (params["force"] as boolean | undefined) ?? false,
    });
    return textResult({ path: fsPath, removed: true });
  },

  async fs_copy(params, ctx) {
    const sourcePath = ctx.resolvePath(params["sourcePath"] as string);
    const destinationPath = ctx.resolvePath(params["destinationPath"] as string);
    await ctx.adapter.fsCopy({
      sourcePath: toFileUri(sourcePath),
      destinationPath: toFileUri(destinationPath),
      recursive: (params["recursive"] as boolean | undefined) ?? false,
    });
    return textResult({ sourcePath, destinationPath, copied: true });
  },

  async fs_getMetadata(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    return textResult({ path: fsPath, ...await ctx.adapter.fsGetMetadata({ path: toFileUri(fsPath) }) });
  },

  async fs_readRange(params, ctx) {
    return textResult(await fsReadRange(params, ctx));
  },

  async fs_search(params, ctx) {
    return textResult(await fsSearch(params, ctx));
  },

  async fs_applyPatch(params, ctx) {
    const result = await fsApplyPatch(params, ctx) as { valid?: boolean };
    return result.valid === false ? { ...textResult(result), isError: true } : textResult(result);
  },

  async process_start(params, ctx) {
    const command = params["command"] as string;
    const args = (params["args"] as string[] | undefined) ?? [];
    const blocked = checkCommand(ctx, command, args);
    if (blocked) return errorResult(blocked);
    const cwd = activeCwd(params, ctx);
    if (!cwd) return errorResult("No active workspace. Call workspace_set first or provide cwd.");
    const processId = await startDirectCommand({
      adapter: ctx.adapter,
      registry: ctx.processRegistry,
      sessionId: ctx.sessionId,
      command,
      args,
      cwd,
      workspace: activeWorkspace(ctx),
      env: params["env"] as Record<string, string> | undefined,
      tty: (params["tty"] as boolean | undefined) ?? false,
    });
    return textResult({ processId, started: true, mode: "direct", argv: [command, ...args] });
  },

  async process_startShell(params, ctx) {
    if (!ctx.allowShell) return errorResult("Shell execution is disabled. Set allowShell: true in CodeHands config to opt in.");
    const script = params["script"] as string;
    if (!script) return errorResult("script must not be empty");
    const argv = shellArgv(script);
    const blocked = checkCommand(ctx, argv[0]!, argv.slice(1));
    if (blocked) return errorResult(blocked);
    const cwd = activeCwd(params, ctx);
    if (!cwd) return errorResult("No active workspace. Call workspace_set first or provide cwd.");
    const processId = await startDirectCommand({
      adapter: ctx.adapter,
      registry: ctx.processRegistry,
      sessionId: ctx.sessionId,
      command: argv[0]!,
      args: argv.slice(1),
      cwd,
      workspace: activeWorkspace(ctx),
      nonPathArgumentIndexes: [argv.length - 2],
      env: params["env"] as Record<string, string> | undefined,
      tty: (params["tty"] as boolean | undefined) ?? false,
    });
    return textResult({ processId, started: true, mode: "shell" });
  },

  async process_run(params, ctx) {
    const command = params["command"] as string;
    const args = (params["args"] as string[] | undefined) ?? [];
    const blocked = checkCommand(ctx, command, args);
    if (blocked) return errorResult(blocked);
    const cwd = activeCwd(params, ctx);
    if (!cwd) return errorResult("No active workspace. Call workspace_set first or provide cwd.");
    const result = await runDirectCommand({
      adapter: ctx.adapter,
      registry: ctx.processRegistry,
      sessionId: ctx.sessionId,
      command,
      args,
      cwd,
      workspace: activeWorkspace(ctx),
      env: params["env"] as Record<string, string> | undefined,
      timeoutMs: params["timeoutMs"] as number | undefined,
      maxOutputBytes: params["maxOutputBytes"] as number | undefined,
    });
    return result.timedOut ? { ...textResult(result), isError: true } : textResult(result);
  },

  async process_read(params, ctx) {
    const processId = params["processId"] as string;
    const reconciled = await ctx.processRegistry.reconcile(ctx.adapter, processId, ctx.sessionId);
    if (!reconciled.found) return errorResult(`Process "${processId}" is unknown to the current exec-server and was marked lost.`);
    const maxBytes = clampOutputBytes(params["maxOutputBytes"] as number | undefined);
    if (!reconciled.response && reconciled.info.status !== "running" && reconciled.info.status !== "stale") {
      const retained = boundedText(reconciled.info.recentOutput ?? "", maxBytes);
      return textResult({
        processId,
        stdout: retained.text,
        stderr: "",
        output: retained.text,
        outputMetadata: retained.output,
        stdoutMetadata: retained.output,
        stderrMetadata: boundedText("", maxBytes).output,
        retained: true,
        exited: true,
        exitCode: reconciled.info.exitCode,
        status: reconciled.info.status,
      });
    }
    const response = reconciled.response ?? await ctx.adapter.processRead({
      processId,
      afterSeq: params["afterSeq"] as number | undefined,
      waitMs: params["waitMs"] as number | undefined,
      maxBytes,
    });
    const streams = chunksToStreams(response.chunks, maxBytes);
    ctx.processRegistry.updateFromRead(processId, response, streams.combined);
    return textResult({
      processId,
      stdout: streams.stdout,
      stderr: streams.stderr,
      output: streams.combined,
      outputMetadata: streams.outputMetadata,
      stdoutMetadata: streams.stdoutMetadata,
      stderrMetadata: streams.stderrMetadata,
      nextSeq: response.nextSeq,
      exited: response.exited,
      exitCode: response.exitCode,
      status: ctx.processRegistry.get(processId)?.status,
    });
  },

  async process_write(params, ctx) {
    const processId = params["processId"] as string;
    const reconciled = await ctx.processRegistry.reconcile(ctx.adapter, processId, ctx.sessionId);
    if (!reconciled.found || reconciled.info.status !== "running") return errorResult(`Process "${processId}" is not running.`);
    const chunk = Buffer.from(params["input"] as string, "utf8").toString("base64");
    const result = await ctx.adapter.processWrite({ processId, chunk, writeId: `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
    if (result.status === "unknownProcess") ctx.processRegistry.markTerminal(processId, "lost");
    return textResult({ processId, status: result.status });
  },

  async process_terminate(params, ctx) {
    const processId = params["processId"] as string;
    const reconciled = await ctx.processRegistry.reconcile(ctx.adapter, processId, ctx.sessionId);
    if (!reconciled.found) return errorResult(`Process "${processId}" is lost and cannot be terminated.`);
    if (reconciled.info.status !== "running" && reconciled.info.status !== "stale") {
      return textResult({ processId, wasRunning: false, status: reconciled.info.status });
    }
    const result = await ctx.adapter.processTerminate({ processId });
    ctx.processRegistry.markTerminal(processId, result.running ? "terminated" : "lost");
    return textResult({ processId, wasRunning: result.running, status: ctx.processRegistry.get(processId)?.status });
  },

  async process_signal(params, ctx) {
    const processId = params["processId"] as string;
    const reconciled = await ctx.processRegistry.reconcile(ctx.adapter, processId, ctx.sessionId);
    if (!reconciled.found || reconciled.info.status !== "running") return errorResult(`Process "${processId}" is not running.`);
    const signal = (params["signal"] as "interrupt" | undefined) ?? "interrupt";
    await ctx.adapter.processSignal({ processId, signal });
    return textResult({ processId, signalSent: signal });
  },

  async process_list(params, ctx) {
    await ctx.processRegistry.reconcileAll(ctx.adapter, ctx.sessionId);
    const statusFilter = params["status"] as string | undefined;
    const sessionFilter = params["session"] as "all" | "current" | undefined;
    const compact = (params["compact"] as boolean | undefined) ?? true;
    const offset = Math.max(0, Math.floor((params["offset"] as number | undefined) ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor((params["limit"] as number | undefined) ?? 20)));
    const filtered = ctx.processRegistry.values()
      .filter(([, info]) => !statusFilter || info.status === statusFilter)
      .filter(([, info]) => sessionFilter !== "current" || info.sessionId === ctx.sessionId)
      .sort((a, b) => Date.parse(b[1].startedAt) - Date.parse(a[1].startedAt));
    const page = filtered.slice(offset, offset + limit).map(([processId, info]) => compact
      ? { processId, command: info.command.slice(0, 160), status: info.status, exitCode: info.exitCode, startedAt: info.startedAt }
      : { processId, ...info });
    return textResult({ processes: page, total: filtered.length, offset, limit, hasMore: offset + page.length < filtered.length, currentSession: ctx.sessionId });
  },

  async http_request(params, ctx) {
    const headersObj = params["headers"] as Record<string, string> | undefined;
    const body = params["body"] as string | undefined;
    const result = await ctx.adapter.httpRequest({
      method: params["method"] as string,
      url: params["url"] as string,
      headers: headersObj ? Object.entries(headersObj).map(([name, value]) => ({ name, value })) : undefined,
      bodyBase64: body ? Buffer.from(body, "utf8").toString("base64") : undefined,
      timeoutMs: params["timeoutMs"] as number | undefined,
      requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
    const responseBody = Buffer.from(result.bodyBase64, "base64").toString("utf8");
    const bounded = boundedText(responseBody, params["maxOutputBytes"] as number | undefined);
    return textResult({
      status: result.status,
      headers: Object.fromEntries(result.headers.map((header) => [header.name, header.value])),
      body: bounded.text,
      output: bounded.output,
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
      return normalized === normalizedInput || normalized.endsWith(`/${normalizedInput}`) || normalizedInput.endsWith(`/${normalized.split("/").pop()!}`);
    });
    if (!found) return errorResult(`Workspace not found: "${workspace}". Use workspace_list to see approved workspaces.`);
    ctx.activeWorkspace = found;
    return textResult({ activeWorkspace: found, set: true });
  },

  async repo_snapshot(params, ctx) { return textResult(await repoSnapshot(params, ctx)); },
  async test_run(params, ctx) { return textResult(await testRun(params, ctx)); },
  async git_diff_summary(params, ctx) { return textResult(await gitDiffSummary(params, ctx)); },
  async agent_start(params, ctx) { return textResult(await agentStart(params, ctx)); },
  async agent_status(params, ctx) { return textResult(await agentStatusTool(params, ctx)); },
  async agent_results(params, ctx) { return textResult(await agentResults(params, ctx)); },
  async agent_cancel(params, ctx) { return textResult(await agentCancel(params, ctx)); },
  async agent_run_many(params, ctx) { return textResult(await agentRunMany(params, ctx)); },

  async wait(params) {
    const ms = Math.max(0, Math.min(30_000, (params["ms"] as number) ?? 1000));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return textResult({ waited: ms });
  },

  async batch(params, ctx) {
    const rawCalls = params["calls"] as Array<{ tool: string; args: string | Record<string, unknown> }>;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) return errorResult("batch requires a non-empty 'calls' array");
    if (rawCalls.length > 20) return errorResult("batch limited to 20 calls per request");
    const results = await Promise.all(rawCalls.map(async (call, index) => {
      const handler = handlers[call.tool];
      if (!handler) return { index, tool: call.tool, success: false, error: `Unknown tool: ${call.tool}` };
      if (call.tool === "batch") return { index, tool: call.tool, success: false, error: "Cannot nest batch calls" };
      let parsedArgs: Record<string, unknown>;
      if (typeof call.args === "string") {
        try { parsedArgs = JSON.parse(call.args) as Record<string, unknown>; }
        catch { return { index, tool: call.tool, success: false, error: "Invalid JSON in args" }; }
      } else parsedArgs = call.args ?? {};
      try {
        const result = await handler(parsedArgs, ctx);
        const raw = result.content[0]?.text ?? "";
        let data: unknown;
        try { data = JSON.parse(raw); } catch { data = raw; }
        return { index, tool: call.tool, success: !result.isError, data };
      } catch (error) {
        return { index, tool: call.tool, success: false, error: error instanceof Error ? error.message : String(error) };
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
