import * as path from "node:path";

export type RepositoryQueryMode = "overview" | "tree" | "search" | "changes";

export interface InternalCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RepositoryQueryContext {
  activeWorkspace: string | null;
  resolvePath: (requestedPath: string) => string;
  runGit: (args: string[], cwd: string) => Promise<InternalCommandResult>;
}

type JsonObject = Record<string, unknown>;

const MAX_RESULTS = 200;
const MAX_DIFF_CHARS = 20_000;

function requireString(params: JsonObject, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function integerOption(params: JsonObject, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = params[name] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function repositoryRelative(workspace: string, absolutePath: string): string {
  const relative = slash(path.relative(workspace, absolutePath));
  return relative === "" ? "." : relative;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function ensureGitSuccess(result: InternalCommandResult, operation: string, acceptedExitCodes = [0]): void {
  if (result.exitCode === null || !acceptedExitCodes.includes(result.exitCode)) {
    throw new Error(result.stderr.trim() || `${operation} failed with exit code ${result.exitCode ?? "unknown"}.`);
  }
}

async function listRepositoryFiles(ctx: RepositoryQueryContext, workspace: string, requestedPath: string): Promise<string[]> {
  const relativePath = repositoryRelative(workspace, requestedPath);
  const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
  if (relativePath !== ".") args.push("--", relativePath);
  const result = await ctx.runGit(args, workspace);
  ensureGitSuccess(result, "git ls-files");
  return lines(result.stdout).map(slash).sort((a, b) => a.localeCompare(b));
}

function page<T>(values: T[], offset: number, maxResults: number): { values: T[]; truncated: boolean; nextOffset?: number } {
  const selected = values.slice(offset, offset + maxResults);
  const truncated = offset + selected.length < values.length;
  return {
    values: selected,
    truncated,
    ...(truncated ? { nextOffset: offset + selected.length } : {}),
  };
}

function globRegex(glob: string, caseSensitive: boolean): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, caseSensitive ? "" : "i");
}

function parseStatusLine(line: string): JsonObject {
  const code = line.slice(0, 2);
  const filePath = line.slice(3).trim();
  return {
    path: slash(filePath),
    code,
    staged: code[0] !== " " && code[0] !== "?",
    worktree: code[1] !== " ",
    untracked: code === "??",
  };
}

function pathMatchesScope(filePath: string, relativePath: string): boolean {
  if (relativePath === ".") return true;
  return filePath === relativePath || filePath.startsWith(`${relativePath}/`);
}

function parseNumstat(stdout: string, staged: boolean): Array<JsonObject> {
  return lines(stdout).map((line) => {
    const [added = "0", deleted = "0", ...fileParts] = line.split("\t");
    return {
      path: slash(fileParts.join("\t")),
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
      binary: added === "-" || deleted === "-",
      staged,
    };
  });
}

export async function runRepositoryQuery(params: JsonObject, ctx: RepositoryQueryContext): Promise<JsonObject> {
  const mode = requireString(params, "mode") as RepositoryQueryMode;
  if (!["overview", "tree", "search", "changes"].includes(mode)) {
    throw new Error("mode must be one of: overview, tree, search, changes.");
  }
  const workspace = ctx.activeWorkspace;
  if (!workspace) throw new Error("No active workspace. Call workspace_set first.");
  const requestedPath = ctx.resolvePath(typeof params["path"] === "string" ? params["path"] as string : ".");
  const relativePath = repositoryRelative(workspace, requestedPath);
  const offset = integerOption(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const maxResults = integerOption(params, "maxResults", 50, 1, MAX_RESULTS);

  if (mode === "overview") {
    const [branch, status, files] = await Promise.all([
      ctx.runGit(["branch", "--show-current"], workspace),
      ctx.runGit(["status", "--short"], workspace),
      listRepositoryFiles(ctx, workspace, requestedPath),
    ]);
    ensureGitSuccess(branch, "git branch");
    ensureGitSuccess(status, "git status");
    const statusEntries = lines(status.stdout)
      .map(parseStatusLine)
      .filter((entry) => pathMatchesScope(entry.path as string, relativePath));
    return {
      mode,
      path: requestedPath,
      relativePath,
      success: true,
      branch: branch.stdout.trim() || null,
      fileCount: files.length,
      changedFileCount: statusEntries.length,
      status: statusEntries,
      topLevel: Array.from(files.reduce((entries, file) => {
        const relative = relativePath === "." ? file : slash(path.posix.relative(relativePath, file));
        const parts = relative.split("/").filter(Boolean);
        if (parts.length > 0) entries.set(parts[0]!, parts.length > 1 ? "directory" : "file");
        return entries;
      }, new Map<string, "directory" | "file">()), ([name, type]) => ({ name, type }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  if (mode === "tree") {
    const maxDepth = integerOption(params, "maxDepth", 6, 0, 20);
    const files = await listRepositoryFiles(ctx, workspace, requestedPath);
    const entries = new Map<string, "directory" | "file">();
    for (const file of files) {
      const relativeToRequested = relativePath === "." ? file : slash(path.posix.relative(relativePath, file));
      if (relativeToRequested.startsWith("../")) continue;
      const parts = relativeToRequested.split("/").filter(Boolean);
      if (parts.length > maxDepth + 1) continue;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const directory = slash(path.posix.join(relativePath === "." ? "" : relativePath, ...parts.slice(0, index + 1)));
        entries.set(directory, "directory");
      }
      entries.set(file, "file");
    }
    const ordered = Array.from(entries, ([entryPath, type]) => ({ path: entryPath, type }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const selected = page(ordered, offset, maxResults);
    return {
      mode,
      path: requestedPath,
      relativePath,
      success: true,
      entries: selected.values,
      total: ordered.length,
      truncated: selected.truncated,
      ...(selected.nextOffset === undefined ? {} : { nextOffset: selected.nextOffset }),
    };
  }

  if (mode === "search") {
    const query = requireString(params, "query");
    const searchIn = (params["searchIn"] as string | undefined) ?? "content";
    const patternType = (params["patternType"] as string | undefined) ?? "literal";
    const caseSensitive = (params["caseSensitive"] as boolean | undefined) ?? false;
    if (!["content", "path"].includes(searchIn)) throw new Error("searchIn must be 'content' or 'path'.");
    if (!["literal", "regex", "glob"].includes(patternType)) throw new Error("patternType must be literal, regex, or glob.");

    if (searchIn === "path") {
      const files = await listRepositoryFiles(ctx, workspace, requestedPath);
      const flags = caseSensitive ? "" : "i";
      const matcher = patternType === "glob"
        ? globRegex(query, caseSensitive)
        : patternType === "regex"
          ? new RegExp(query, flags)
          : null;
      const normalizedQuery = caseSensitive ? query : query.toLowerCase();
      const matches = files.filter((file) => {
        const value = caseSensitive ? file : file.toLowerCase();
        return matcher ? matcher.test(file) : value.includes(normalizedQuery);
      }).map((file) => ({ path: file }));
      const selected = page(matches, offset, maxResults);
      return {
        mode,
        path: requestedPath,
        relativePath,
        success: true,
        searchIn,
        patternType,
        query,
        matches: selected.values,
        total: matches.length,
        truncated: selected.truncated,
        ...(selected.nextOffset === undefined ? {} : { nextOffset: selected.nextOffset }),
      };
    }

    if (patternType === "glob") throw new Error("glob is supported only for path searches.");
    const args = ["grep", "--untracked", "--exclude-standard", "-n", "-I"];
    if (!caseSensitive) args.push("-i");
    args.push(patternType === "literal" ? "-F" : "-E", "-e", query);
    if (relativePath !== ".") args.push("--", relativePath);
    const result = await ctx.runGit(args, workspace);
    ensureGitSuccess(result, "git grep", [0, 1]);
    const matches = lines(result.stdout).map((line) => {
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      return match
        ? { path: slash(match[1]!), line: Number(match[2]), text: match[3] }
        : { path: "", line: 0, text: line };
    });
    const selected = page(matches, offset, maxResults);
    return {
      mode,
      path: requestedPath,
      relativePath,
      success: true,
      searchIn,
      patternType,
      query,
      includesUntracked: true,
      matches: selected.values,
      total: matches.length,
      truncated: selected.truncated,
      ...(selected.nextOffset === undefined ? {} : { nextOffset: selected.nextOffset }),
    };
  }

  const [status, unstaged, staged] = await Promise.all([
    ctx.runGit(["status", "--short"], workspace),
    ctx.runGit(["diff", "--numstat", "--", relativePath], workspace),
    ctx.runGit(["diff", "--cached", "--numstat", "--", relativePath], workspace),
  ]);
  ensureGitSuccess(status, "git status");
  ensureGitSuccess(unstaged, "git diff --numstat");
  ensureGitSuccess(staged, "git diff --cached --numstat");
  const statusEntries = lines(status.stdout)
    .map(parseStatusLine)
    .filter((entry) => pathMatchesScope(entry.path as string, relativePath));
  const changes = [...parseNumstat(staged.stdout, true), ...parseNumstat(unstaged.stdout, false)];
  const selected = page(changes, offset, maxResults);
  const includeDiff = (params["includeDiff"] as boolean | undefined) ?? false;
  let diff: string | undefined;
  let diffTruncated: boolean | undefined;
  if (includeDiff) {
    const maxDiffChars = integerOption(params, "maxDiffChars", 12_000, 1, MAX_DIFF_CHARS);
    const [stagedDiff, unstagedDiff] = await Promise.all([
      ctx.runGit(["diff", "--cached", "--no-ext-diff", "--unified=3", "--", relativePath], workspace),
      ctx.runGit(["diff", "--no-ext-diff", "--unified=3", "--", relativePath], workspace),
    ]);
    ensureGitSuccess(stagedDiff, "git diff --cached");
    ensureGitSuccess(unstagedDiff, "git diff");
    const complete = [stagedDiff.stdout, unstagedDiff.stdout].filter(Boolean).join("\n");
    diff = complete.slice(0, maxDiffChars);
    diffTruncated = diff.length < complete.length;
  }
  return {
    mode,
    path: requestedPath,
    relativePath,
    success: true,
    status: statusEntries,
    changes: selected.values,
    total: changes.length,
    truncated: selected.truncated,
    ...(selected.nextOffset === undefined ? {} : { nextOffset: selected.nextOffset }),
    ...(diff === undefined ? {} : { diff, diffTruncated }),
  };
}
