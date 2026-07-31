import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createWorkspaceSandbox,
  type CodexAdapter,
  type FileSystemSandboxContext,
} from "@codehands/codex-adapter";
import type { CommandPolicy, HttpPolicy } from "@codehands/policy-engine";

export interface ToolContext {
  adapter: CodexAdapter;
  activeWorkspace: string | null;
  workspaces: string[];
  resolvePath: (relativePath: string) => string;
  commandPolicy: CommandPolicy;
  httpPolicy: HttpPolicy;
  ownedProcesses: Set<string>;
  recentActivity: (limit: number) => unknown[];
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

function requireWorkspace(ctx: ToolContext): string {
  if (!ctx.activeWorkspace) {
    throw new Error("No active workspace. Call workspace_set first.");
  }
  return ctx.activeWorkspace;
}

function sandboxFor(ctx: ToolContext): FileSystemSandboxContext {
  return createWorkspaceSandbox(toFileUri(requireWorkspace(ctx)));
}

async function readTextFile(ctx: ToolContext, fsPath: string): Promise<string> {
  const result = await ctx.adapter.fsReadFile({
    path: toFileUri(fsPath),
    sandbox: sandboxFor(ctx),
  });
  return Buffer.from(result.dataBase64, "base64").toString("utf-8");
}

async function writeTextFile(ctx: ToolContext, fsPath: string, content: string): Promise<void> {
  await ctx.adapter.fsWriteFile({
    path: toFileUri(fsPath),
    dataBase64: Buffer.from(content, "utf-8").toString("base64"),
    sandbox: sandboxFor(ctx),
  });
}

function assertOwnedProcess(ctx: ToolContext, processId: string): void {
  if (!ctx.ownedProcesses.has(processId)) {
    throw new Error(`Process "${processId}" does not belong to this MCP session`);
  }
}

function baseEnvironment(workspace: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of os.platform() === "win32"
    ? ["PATH", "SystemRoot", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "LANG"]) {
    if (process.env[key]) result[key] = process.env[key]!;
  }
  if (os.platform() === "win32") {
    result["USERPROFILE"] = workspace;
  } else {
    result["HOME"] = workspace;
  }
  result["GIT_CONFIG_GLOBAL"] = os.platform() === "win32" ? "NUL" : "/dev/null";
  result["GIT_CONFIG_NOSYSTEM"] = "1";
  return result;
}

async function runCaptured(
  ctx: ToolContext,
  argv: string[],
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ output: string; exitCode: number | undefined }> {
  const workspace = requireWorkspace(ctx);
  const executableCheck = ctx.commandPolicy.validateExecutable(argv[0] ?? "");
  if (!executableCheck.allowed) throw new Error(executableCheck.reason);

  const processId = `internal-${randomUUID()}`;
  const response = await ctx.adapter.processStart({
    processId,
    argv,
    cwd: toFileUri(workspace),
    env: baseEnvironment(workspace),
    tty: false,
    pipeStdin: false,
    sandbox: sandboxFor(ctx),
  });
  ctx.ownedProcesses.add(response.processId);

  const timeoutAt = Date.now() + (options.timeoutMs ?? 15_000);
  const maxBytes = options.maxBytes ?? 256 * 1024;
  let afterSeq = 0;
  let output = "";
  try {
    while (Date.now() < timeoutAt) {
      const result = await ctx.adapter.processRead({
        processId: response.processId,
        afterSeq,
        maxBytes: Math.max(1, maxBytes - Buffer.byteLength(output, "utf-8")),
        waitMs: 500,
      });
      output += result.chunks
        .map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf-8"))
        .join("");
      afterSeq = result.nextSeq;
      if (Buffer.byteLength(output, "utf-8") >= maxBytes) {
        await ctx.adapter.processTerminate({ processId: response.processId });
        throw new Error(`Command output exceeded ${maxBytes} bytes`);
      }
      if (result.exited || result.closed) {
        return { output, exitCode: result.exitCode };
      }
    }
    await ctx.adapter.processTerminate({ processId: response.processId });
    throw new Error(`Command timed out after ${options.timeoutMs ?? 15_000}ms`);
  } finally {
    ctx.ownedProcesses.delete(response.processId);
  }
}

function applyUnifiedPatch(original: string, patch: string): string {
  const originalEndsWithNewline = original.endsWith("\n");
  const source = original.split("\n");
  if (originalEndsWithNewline) source.pop();
  const patchLines = patch.split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  let sawHunk = false;

  for (let patchIndex = 0; patchIndex < patchLines.length;) {
    const header = patchLines[patchIndex]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) {
      patchIndex += 1;
      continue;
    }

    sawHunk = true;
    const oldStart = Number(header[1]) - 1;
    if (oldStart < sourceIndex || oldStart > source.length) {
      throw new Error(`Patch hunk starts at invalid or overlapping source line ${oldStart + 1}`);
    }
    output.push(...source.slice(sourceIndex, oldStart));
    sourceIndex = oldStart;
    patchIndex += 1;

    while (patchIndex < patchLines.length && !patchLines[patchIndex]!.startsWith("@@ ")) {
      const line = patchLines[patchIndex]!;
      patchIndex += 1;
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const content = line.slice(1);
      if (marker === " ") {
        if (source[sourceIndex] !== content) {
          throw new Error(`Patch context mismatch at source line ${sourceIndex + 1}`);
        }
        output.push(content);
        sourceIndex += 1;
      } else if (marker === "-") {
        if (source[sourceIndex] !== content) {
          throw new Error(`Patch removal mismatch at source line ${sourceIndex + 1}`);
        }
        sourceIndex += 1;
      } else if (marker === "+") {
        output.push(content);
      } else if (line.startsWith("--- ") || line.startsWith("+++ ") || line === "") {
        continue;
      } else {
        throw new Error(`Unsupported patch line: ${line}`);
      }
    }
  }

  if (!sawHunk) throw new Error("Patch does not contain any unified-diff @@ hunks");
  output.push(...source.slice(sourceIndex));
  return output.join("\n") + (originalEndsWithNewline ? "\n" : "");
}

const handlers: Record<string, HandlerFn> = {
  async fs_readFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const text = await readTextFile(ctx, fsPath);
    const startLine = params["startLine"] as number | undefined;
    const endLine = params["endLine"] as number | undefined;
    if (startLine !== undefined || endLine !== undefined) {
      const lines = text.split("\n");
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      if (end < start) return errorResult("endLine must be greater than or equal to startLine");
      return textResult({ path: fsPath, startLine: start, endLine: end, content: lines.slice(start - 1, end).join("\n") });
    }
    return textResult({ path: fsPath, content: text });
  },

  async fs_replaceText(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const oldText = params["oldText"] as string;
    const newText = params["newText"] as string;
    const replaceAll = (params["replaceAll"] as boolean | undefined) ?? false;
    if (!oldText) return errorResult("oldText must not be empty");

    const original = await readTextFile(ctx, fsPath);
    const matches = original.split(oldText).length - 1;
    if (matches === 0) return errorResult("Expected oldText was not found; no changes were written");
    if (!replaceAll && matches !== 1) {
      return errorResult(`Expected exactly one oldText match but found ${matches}; no changes were written`);
    }
    const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
    await writeTextFile(ctx, fsPath, updated);
    return textResult({ path: fsPath, replaced: replaceAll ? matches : 1, bytes: Buffer.byteLength(updated, "utf-8") });
  },

  async fs_applyPatch(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const original = await readTextFile(ctx, fsPath);
    const updated = applyUnifiedPatch(original, params["patch"] as string);
    await writeTextFile(ctx, fsPath, updated);
    return textResult({ path: fsPath, patched: true, bytes: Buffer.byteLength(updated, "utf-8") });
  },

  async fs_searchText(params, ctx) {
    const query = params["query"] as string;
    if (!query) return errorResult("query must not be empty");
    const searchPath = ctx.resolvePath((params["path"] as string | undefined) ?? ".");
    const maxResults = Math.max(1, Math.min(500, (params["maxResults"] as number | undefined) ?? 100));
    const argv = [
      "rg",
      "--line-number",
      "--column",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(maxResults),
    ];
    if ((params["fixedStrings"] as boolean | undefined) ?? false) argv.push("--fixed-strings");
    if (params["glob"]) argv.push("--glob", params["glob"] as string);
    argv.push("--", query, searchPath);
    const result = await runCaptured(ctx, argv);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return errorResult(`Text search failed with exit code ${result.exitCode}: ${result.output}`);
    }
    const matches = result.output.trim() ? result.output.trimEnd().split("\n").slice(0, maxResults) : [];
    return textResult({ query, matches, truncated: matches.length >= maxResults });
  },

  async fs_writeFile(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const content = params["content"] as string;
    await writeTextFile(ctx, fsPath, content);
    return textResult({ path: fsPath, written: true, bytes: Buffer.byteLength(content, "utf-8") });
  },

  async fs_createDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? true;
    await ctx.adapter.fsCreateDirectory({ path: toFileUri(fsPath), recursive, sandbox: sandboxFor(ctx) });
    return textResult({ path: fsPath, created: true });
  },

  async fs_readDirectory(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsReadDirectory({ path: toFileUri(fsPath), sandbox: sandboxFor(ctx) });
    return textResult({ path: fsPath, entries: result.entries });
  },

  async fs_walk(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsWalk({
      path: toFileUri(fsPath),
      options: {
        maxDepth: (params["maxDepth"] as number | undefined) ?? 8,
        maxDirectories: 10_000,
        maxEntries: 50_000,
        followDirectorySymlinks: false,
        pruneHiddenDirectories: true,
      },
      sandbox: sandboxFor(ctx),
    });
    return textResult(result);
  },

  async fs_remove(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? false;
    const force = (params["force"] as boolean | undefined) ?? false;
    await ctx.adapter.fsRemove({ path: toFileUri(fsPath), recursive, force, sandbox: sandboxFor(ctx) });
    return textResult({ path: fsPath, removed: true });
  },

  async fs_copy(params, ctx) {
    const sourcePath = ctx.resolvePath(params["sourcePath"] as string);
    const destinationPath = ctx.resolvePath(params["destinationPath"] as string);
    const recursive = (params["recursive"] as boolean | undefined) ?? false;
    await ctx.adapter.fsCopy({
      sourcePath: toFileUri(sourcePath),
      destinationPath: toFileUri(destinationPath),
      recursive,
      sandbox: sandboxFor(ctx),
    });
    return textResult({ sourcePath, destinationPath, copied: true });
  },

  async fs_getMetadata(params, ctx) {
    const fsPath = ctx.resolvePath(params["path"] as string);
    const result = await ctx.adapter.fsGetMetadata({ path: toFileUri(fsPath), sandbox: sandboxFor(ctx) });
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

    const executableCheck = ctx.commandPolicy.validateExecutable(command);
    if (!executableCheck.allowed) return errorResult(executableCheck.reason!);
    const environmentCheck = ctx.commandPolicy.validateEnvironment(customEnv);
    if (!environmentCheck.allowed) return errorResult(environmentCheck.reason!);

    const env = { ...baseEnvironment(cwd), ...customEnv };
    const result = await ctx.adapter.processStart({
      argv: [command, ...args],
      cwd: toFileUri(cwd),
      env,
      tty,
      pipeStdin: true,
      sandbox: sandboxFor(ctx),
    });
    ctx.ownedProcesses.add(result.processId);
    return textResult({ processId: result.processId, started: true, sandboxType: result.sandboxType });
  },

  async process_read(params, ctx) {
    const processId = params["processId"] as string;
    assertOwnedProcess(ctx, processId);
    const afterSeq = params["afterSeq"] as number | undefined;
    const waitMs = params["waitMs"] as number | undefined;
    const result = await ctx.adapter.processRead({ processId, afterSeq, waitMs });

    const output = result.chunks
      .map((c) => Buffer.from(c.chunk, "base64").toString("utf-8"))
      .join("");

    if (result.exited || result.closed) ctx.ownedProcesses.delete(processId);
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
    assertOwnedProcess(ctx, processId);
    const input = params["input"] as string;
    const chunk = Buffer.from(input, "utf-8").toString("base64");
    const writeId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await ctx.adapter.processWrite({ processId, chunk, writeId });
    return textResult({ processId, status: result.status });
  },

  async process_terminate(params, ctx) {
    const processId = params["processId"] as string;
    assertOwnedProcess(ctx, processId);
    const result = await ctx.adapter.processTerminate({ processId });
    ctx.ownedProcesses.delete(processId);
    return textResult({ processId, wasRunning: result.running });
  },

  async process_signal(params, ctx) {
    const processId = params["processId"] as string;
    assertOwnedProcess(ctx, processId);
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
    const policyCheck = await ctx.httpPolicy.validate(method, url);
    if (!policyCheck.allowed) return errorResult(policyCheck.reason!);

    const headers = headersObj
      ? Object.entries(headersObj).map(([name, value]) => ({ name, value }))
      : undefined;

    const bodyBase64 = body ? Buffer.from(body, "utf-8").toString("base64") : undefined;
    const requestId = `req-${randomUUID()}`;

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

    const candidates = ctx.workspaces.filter((w) => {
      const nw = normalize(w);
      return nw === normalizedInput
        || nw.endsWith(`/${normalizedInput}`)
        || normalizedInput.endsWith(`/${nw.split("/").pop()!}`);
    });
    if (candidates.length > 1) {
      return errorResult(
        `Workspace name "${workspace}" is ambiguous. Use an exact path from workspace_list.`,
      );
    }
    const found = candidates[0];
    if (!found) {
      return errorResult(
        `Workspace not found: "${workspace}". Use workspace_list to see approved workspaces.`,
      );
    }
    ctx.activeWorkspace = found;
    return textResult({ activeWorkspace: found, set: true });
  },

  async git_status(_params, ctx) {
    const result = await runCaptured(ctx, ["git", "status", "--short", "--branch"]);
    if (result.exitCode !== 0) {
      return errorResult(`git status failed with exit code ${result.exitCode}: ${result.output}`);
    }
    return textResult({ workspace: requireWorkspace(ctx), status: result.output });
  },

  async git_diff(params, ctx) {
    const argv = ["git", "diff", "--no-ext-diff", "--no-color"];
    if ((params["staged"] as boolean | undefined) ?? false) argv.push("--cached");
    const base = params["base"] as string | undefined;
    if (base) {
      if (!/^[A-Za-z0-9._/@^~:+-]+$/.test(base)) {
        return errorResult("base contains unsupported characters");
      }
      argv.push(base);
    }
    if (params["path"]) {
      const resolved = ctx.resolvePath(params["path"] as string);
      const canonicalWorkspace = ctx.resolvePath(".");
      argv.push("--", path.relative(canonicalWorkspace, resolved) || ".");
    }
    const result = await runCaptured(ctx, argv, { maxBytes: 512 * 1024 });
    if (result.exitCode !== 0) {
      return errorResult(`git diff failed with exit code ${result.exitCode}: ${result.output}`);
    }
    return textResult({ workspace: requireWorkspace(ctx), diff: result.output });
  },

  async activity_recent(params, ctx) {
    const limit = Math.max(1, Math.min(100, (params["limit"] as number | undefined) ?? 20));
    return textResult({ activity: ctx.recentActivity(limit) });
  },
};

export function getHandler(toolName: string): HandlerFn | undefined {
  return handlers[toolName];
}

export function getAllHandlerNames(): string[] {
  return Object.keys(handlers);
}
