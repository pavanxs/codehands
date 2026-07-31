import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as os from "node:os";
import type { CodexAdapter } from "@codehands/codex-adapter";

export interface ToolContext {
  adapter: CodexAdapter;
  activeWorkspace: string | null;
  workspaces: string[];
  resolvePath: (relativePath: string) => string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type HandlerFn = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

function toFileUri(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}

function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

const handlers: Record<string, HandlerFn> = {
  async fs_readFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsReadFile({ path: toFileUri(fsPath) });
    const text = Buffer.from(result.dataBase64, "base64").toString("utf-8");
    return textResult({ path: fsPath, content: text });
  },

  async fs_writeFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const content = params["content"] as string;
    const dataBase64 = Buffer.from(content, "utf-8").toString("base64");
    await ctx.adapter.fsWriteFile({ path: toFileUri(fsPath), dataBase64 });
    return textResult({ path: fsPath, written: true, bytes: Buffer.byteLength(content, "utf-8") });
  },

  async fs_createDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? true;
    await ctx.adapter.fsCreateDirectory({ path: toFileUri(fsPath), recursive });
    return textResult({ path: fsPath, created: true });
  },

  async fs_readDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsReadDirectory({ path: toFileUri(fsPath) });
    return textResult({ path: fsPath, entries: result.entries });
  },

  async fs_walk(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const options: Record<string, unknown> = {};
    if (params["maxDepth"] !== undefined) {
      options["maxDepth"] = params["maxDepth"];
    }
    const result = await ctx.adapter.fsWalk({ path: toFileUri(fsPath), options });
    return textResult(result);
  },

  async fs_remove(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? false;
    const force = (params["force"] as boolean | undefined) ?? false;
    await ctx.adapter.fsRemove({ path: toFileUri(fsPath), recursive, force });
    return textResult({ path: fsPath, removed: true });
  },

  async fs_copy(params, ctx) {
    const sourcePath = ctx.resolvePath(params["sourcePath"] as string);
    const destinationPath = ctx.resolvePath(params["destinationPath"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? false;
    await ctx.adapter.fsCopy({ sourcePath: toFileUri(sourcePath), destinationPath: toFileUri(destinationPath), recursive });
    return textResult({ sourcePath, destinationPath, copied: true });
  },

  async fs_getMetadata(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsGetMetadata({ path: toFileUri(fsPath) });
    return textResult({ path: fsPath, ...result });
  },

  async process_start(params, ctx) {
    const command = params["command"] as string;
    const args = (params["args"] as string[] | undefined) ?? [];
    const cwd = params["cwd"]
      ? ctx.resolvePath(params["cwd"] as string)
      : ctx.activeWorkspace ?? undefined;
    const customEnv = params["env"] as Record<string, string> | undefined;
    const tty = (params["tty"] as boolean | undefined) ?? false;

    if (!cwd) {
      return errorResult("No active workspace. Call workspace_set first or provide cwd.");
    }

    const isWindows = os.platform() === "win32";
    const fullCommand = args.length > 0 ? [command, ...args].join(" ") : command;
    const argv = isWindows
      ? ["cmd.exe", "/c", fullCommand]
      : ["/bin/sh", "-c", fullCommand];

    const baseEnv: Record<string, string> = {};
    if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
    if (isWindows && process.env["SystemRoot"]) baseEnv["SystemRoot"] = process.env["SystemRoot"];
    if (isWindows && process.env["USERPROFILE"]) baseEnv["USERPROFILE"] = process.env["USERPROFILE"];
    if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];

    const env = { ...baseEnv, ...customEnv };
    const result = await ctx.adapter.processStart({ argv, cwd: toFileUri(cwd), env, tty });
    return textResult({ processId: result.processId, started: true });
  },

  async process_read(params, ctx) {
    void ctx;
    const processId = params["processId"] as string;
    const afterSeq = params["afterSeq"] as number | undefined;
    const waitMs = params["waitMs"] as number | undefined;
    const result = await ctx.adapter.processRead({ processId, afterSeq, waitMs });

    const output = result.chunks
      .map((c) => Buffer.from(c.chunk, "base64").toString("utf-8"))
      .join("");

    return textResult({
      processId,
      output,
      nextSeq: result.nextSeq,
      exited: result.exited,
      exitCode: result.exitCode,
    });
  },

  async process_write(params, ctx) {
    const processId = params["processId"] as string;
    const input = params["input"] as string;
    const chunk = Buffer.from(input, "utf-8").toString("base64");
    const writeId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await ctx.adapter.processWrite({ processId, chunk, writeId });
    return textResult({ processId, status: result.status });
  },

  async process_terminate(params, ctx) {
    const processId = params["processId"] as string;
    const result = await ctx.adapter.processTerminate({ processId });
    return textResult({ processId, wasRunning: result.running });
  },

  async process_signal(params, ctx) {
    const processId = params["processId"] as string;
    const signal = (params["signal"] as "interrupt" | undefined) ?? "interrupt";
    await ctx.adapter.processSignal({ processId, signal });
    return textResult({ processId, signalSent: signal });
  },

  async http_request(params, ctx) {
    const method = params["method"] as string;
    const url = params["url"] as string;
    const headersObj = params["headers"] as Record<string, string> | undefined;
    const body = params["body"] as string | undefined;
    const timeoutMs = params["timeoutMs"] as number | undefined;

    const headers = headersObj
      ? Object.entries(headersObj).map(([name, value]) => ({ name, value }))
      : undefined;

    const bodyBase64 = body ? Buffer.from(body, "utf-8").toString("base64") : undefined;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const result = await ctx.adapter.httpRequest({
      method,
      url,
      headers,
      bodyBase64,
      timeoutMs,
      requestId,
    });

    const responseBody = Buffer.from(result.bodyBase64, "base64").toString("utf-8");
    const responseHeaders: Record<string, string> = {};
    for (const h of result.headers) {
      responseHeaders[h.name] = h.value;
    }

    return textResult({ status: result.status, headers: responseHeaders, body: responseBody });
  },

  async workspace_list(_params, ctx) {
    return textResult({
      workspaces: ctx.workspaces,
      activeWorkspace: ctx.activeWorkspace,
    });
  },

  async workspace_set(params, ctx) {
    const workspace = params["workspace"] as string;
    const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const normalizedInput = normalize(workspace);

    const found = ctx.workspaces.find((w) => {
      const nw = normalize(w);
      return nw === normalizedInput
        || nw.endsWith(`/${normalizedInput}`)
        || normalizedInput.endsWith(`/${nw.split("/").pop()!}`);
    });
    if (!found) {
      return errorResult(
        `Workspace not found: "${workspace}". Use workspace_list to see approved workspaces.`,
      );
    }
    ctx.activeWorkspace = found;
    return textResult({ activeWorkspace: found, set: true });
  },
};

export function getHandler(toolName: string): HandlerFn | undefined {
  return handlers[toolName];
}

export function getAllHandlerNames(): string[] {
  return Object.keys(handlers);
}
