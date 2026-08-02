import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { boundedText } from "./output.js";
import { runDirectCommand, type RunCommandResult } from "./process-runtime.js";
import type { ToolContext } from "./context.js";

const MAX_SEARCH_RESULTS = 500;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_READ_LINES = 2_000;

async function run(
  ctx: ToolContext,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
): Promise<RunCommandResult> {
  if (!ctx.activeWorkspace) throw new Error("No active workspace. Call workspace_set first.");
  const blocked = ctx.checkBlocked?.(command, args);
  if (blocked) throw new Error(blocked);
  return runDirectCommand({
    adapter: ctx.adapter,
    registry: ctx.processRegistry,
    sessionId: ctx.sessionId,
    command,
    args,
    cwd,
    workspace: ctx.activeWorkspace,
    timeoutMs,
    maxOutputBytes,
  });
}

function requireSuccess(result: RunCommandResult, label: string): string {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function resolveRepository(ctx: ToolContext, requested?: string): Promise<string> {
  const cwd = requested ? ctx.resolvePath(requested) : ctx.activeWorkspace;
  if (!cwd) throw new Error("No active workspace. Call workspace_set first or provide path.");
  const result = await run(ctx, "git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd);
  return ctx.resolvePath(requireSuccess(result, "Git repository check"));
}

export async function repoSnapshot(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const repo = await resolveRepository(ctx, params["path"] as string | undefined);
  const maxOutputBytes = params["maxOutputBytes"] as number | undefined;
  const [branch, head, status, remotes, rootEntries] = await Promise.all([
    run(ctx, "git", ["-C", repo, "branch", "--show-current"], repo, 20_000, 8_192),
    run(ctx, "git", ["-C", repo, "rev-parse", "--short=12", "HEAD"], repo, 20_000, 8_192),
    run(ctx, "git", ["-C", repo, "status", "--short", "--branch"], repo, 20_000, maxOutputBytes),
    run(ctx, "git", ["-C", repo, "remote", "-v"], repo, 20_000, 16_384),
    ctx.adapter.fsReadDirectory({ path: pathToFileURL(repo).href }),
  ]);

  const names = new Set(rootEntries.entries.map((entry) => entry.fileName));
  const packageHints = ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "pyproject.toml", "Cargo.toml", "go.mod"]
    .filter((name) => names.has(name));
  let testHints: string[] = [];
  if (names.has("package.json")) {
    try {
      const packageJson = await ctx.adapter.fsReadFile({ path: pathToFileURL(path.join(repo, "package.json")).href });
      const parsed = JSON.parse(Buffer.from(packageJson.dataBase64, "base64").toString("utf8")) as { scripts?: Record<string, string> };
      testHints = Object.keys(parsed.scripts ?? {}).filter((name) => /^(test|check|lint|typecheck|build)(:|$)/.test(name));
    } catch {
      testHints = [];
    }
  }

  return {
    repository: repo,
    branch: branch.stdout.trim() || null,
    head: head.stdout.trim(),
    status: status.stdout,
    remotes: remotes.stdout.split("\n").filter(Boolean).slice(0, 20),
    packageHints,
    testHints,
    output: status.output,
  };
}

function escapeGlobLiteral(value: string): string {
  return value.replace(/([*?[\]{}!\\])/g, "\\$1");
}

export async function fsSearch(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const root = ctx.resolvePath((params["path"] as string | undefined) ?? ".");
  const mode = (params["mode"] as "text" | "path" | undefined) ?? "text";
  const query = params["query"] as string;
  if (!query) throw new Error("query must not be empty");
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor((params["limit"] as number | undefined) ?? DEFAULT_SEARCH_RESULTS)));
  const args = mode === "path"
    ? ["--files", "--hidden", "--glob", `**/*${escapeGlobLiteral(query)}*`]
    : ["--line-number", "--column", "--no-heading", "--color", "never", ...(params["regex"] ? [] : ["--fixed-strings"]), query];
  for (const include of (params["include"] as string[] | undefined) ?? []) args.push("--glob", include);
  for (const exclude of (params["exclude"] as string[] | undefined) ?? []) args.push("--glob", `!${exclude}`);
  args.push(root);
  const result = await run(ctx, "rg", args, root, 30_000, params["maxOutputBytes"] as number | undefined);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`Search failed: ${result.stderr}`);
  const allResults = result.stdout.split("\n").filter(Boolean);
  const results = allResults.slice(0, limit);
  return {
    mode,
    root,
    results,
    count: results.length,
    limit,
    output: { ...result.output, truncated: result.output.truncated || allResults.length > limit },
  };
}

export async function fsReadRange(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const fsPath = ctx.resolvePath(params["path"] as string);
  const startLine = Math.max(1, Math.floor((params["startLine"] as number | undefined) ?? 1));
  const requestedEnd = Math.floor((params["endLine"] as number | undefined) ?? startLine + 199);
  const endLine = Math.max(startLine, Math.min(requestedEnd, startLine + MAX_READ_LINES - 1));
  const response = await ctx.adapter.fsReadFile({ path: pathToFileURL(fsPath).href });
  const content = Buffer.from(response.dataBase64, "base64").toString("utf8");
  const lines = content.split(/\r?\n/);
  const selected = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n");
  const bounded = boundedText(selected, params["maxOutputBytes"] as number | undefined);
  return {
    path: fsPath,
    startLine,
    endLine: Math.min(endLine, lines.length),
    totalLines: lines.length,
    content: bounded.text,
    output: bounded.output,
  };
}

function validatePatch(patch: string): void {
  if (!patch.trim()) throw new Error("patch must not be empty");
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const raw = line.slice(4).split("\t", 1)[0] ?? "";
    if (raw === "/dev/null") continue;
    const candidate = raw.replace(/^[ab]\//, "");
    if (path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe patch path: ${raw}`);
    }
  }
}

export async function fsApplyPatch(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const patch = params["patch"] as string;
  validatePatch(patch);
  const repo = await resolveRepository(ctx, params["path"] as string | undefined);
  const patchDir = ctx.resolvePath(path.join(repo, ".codehands", "patches"));
  const patchPath = ctx.resolvePath(path.join(patchDir, `${randomUUID()}.patch`));
  await ctx.adapter.fsCreateDirectory({ path: pathToFileURL(patchDir).href, recursive: true });
  await ctx.adapter.fsWriteFile({ path: pathToFileURL(patchPath).href, dataBase64: Buffer.from(patch, "utf8").toString("base64") });
  const dryRun = (params["dryRun"] as boolean | undefined) ?? false;
  try {
    const args = ["-C", repo, "apply", ...(dryRun ? ["--check"] : []), "--", patchPath];
    const result = await run(ctx, "git", args, repo, 30_000, 32_768);
    return {
      repository: repo,
      applied: result.exitCode === 0 && !dryRun,
      valid: result.exitCode === 0,
      dryRun,
      exitCode: result.exitCode,
      stderr: result.stderr,
      output: result.output,
    };
  } finally {
    await ctx.adapter.fsRemove({ path: pathToFileURL(patchPath).href, force: true });
  }
}

export async function testRun(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const name = (params["name"] as string | undefined) ?? "default";
  const configured = ctx.testCommands[name];
  if (!configured) throw new Error(`Test command "${name}" is not configured`);
  const cwd = configured.cwd ? ctx.resolvePath(configured.cwd) : ctx.activeWorkspace;
  if (!cwd) throw new Error("No active workspace for test command");
  const blocked = ctx.checkBlocked?.(configured.command, configured.args);
  if (blocked) throw new Error(blocked);
  const result = await runDirectCommand({
    adapter: ctx.adapter,
    registry: ctx.processRegistry,
    sessionId: ctx.sessionId,
    command: configured.command,
    args: configured.args,
    cwd,
    workspace: ctx.activeWorkspace!,
    timeoutMs: params["timeoutMs"] as number | undefined,
    maxOutputBytes: params["maxOutputBytes"] as number | undefined,
  });
  return { name, command: [configured.command, ...(configured.args ?? [])], cwd, passed: result.exitCode === 0 && !result.timedOut, ...result };
}

function validateRef(ref: string): void {
  if (!ref || ref.startsWith("-") || !/^[A-Za-z0-9._/@{}+-]+$/.test(ref) || ref.includes("..")) {
    throw new Error(`Invalid base ref: ${ref}`);
  }
}

export async function gitDiffSummary(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const repo = await resolveRepository(ctx, params["path"] as string | undefined);
  const base = params["baseRef"] as string | undefined;
  if (base) validateRef(base);
  const range = base ? [`${base}...HEAD`] : [];
  const [status, stat, names] = await Promise.all([
    run(ctx, "git", ["-C", repo, "status", "--short"], repo, 20_000, 32_768),
    run(ctx, "git", ["-C", repo, "diff", "--stat", ...range, "--"], repo, 20_000, params["maxOutputBytes"] as number | undefined),
    run(ctx, "git", ["-C", repo, "diff", "--name-status", ...range, "--"], repo, 20_000, 64 * 1024),
  ]);
  return {
    repository: repo,
    baseRef: base ?? null,
    status: status.stdout.split("\n").filter(Boolean),
    stat: stat.stdout,
    files: names.stdout.split("\n").filter(Boolean),
    output: stat.output,
  };
}
