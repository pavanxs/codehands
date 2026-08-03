import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { runRepositoryQuery, type InternalCommandResult, type RepositoryQueryContext } from "./repository-query.js";

function gitResult(stdout = "", exitCode = 0, stderr = ""): InternalCommandResult {
  return { stdout, stderr, exitCode };
}

function createContext(): RepositoryQueryContext {
  const workspace = path.resolve("repository-query-fixture");
  return {
    activeWorkspace: workspace,
    resolvePath: (requested) => path.resolve(workspace, requested),
    runGit: async (args) => {
      const command = args.join(" ");
      if (command === "branch --show-current") return gitResult("main\n");
      if (command === "status --short") return gitResult(" M src/a.ts\n?? new.txt\n");
      if (command.startsWith("ls-files")) return gitResult("README.md\nnew.txt\nsrc/a.ts\nsrc/b.ts\n");
      if (command.startsWith("grep ")) return gitResult("src/a.ts:2:needle here\n");
      if (command.startsWith("diff --cached --numstat")) return gitResult("3\t1\tsrc/a.ts\n");
      if (command.startsWith("diff --numstat")) return gitResult("1\t0\tREADME.md\n");
      if (command.startsWith("diff --cached --no-ext-diff")) return gitResult("cached diff\n");
      if (command.startsWith("diff --no-ext-diff")) return gitResult("working diff\n");
      return gitResult("", 1, `unexpected git command: ${command}`);
    },
  };
}

describe("repository query", () => {
  it("returns repository overview metadata", async () => {
    const result = await runRepositoryQuery({ mode: "overview" }, createContext());
    expect(result).toMatchObject({
      mode: "overview",
      success: true,
      branch: "main",
      fileCount: 4,
      changedFileCount: 2,
    });
    expect(result.topLevel).toEqual([
      { name: "new.txt", type: "file" },
      { name: "README.md", type: "file" },
      { name: "src", type: "directory" },
    ]);
  });

  it("returns bounded tree entries with continuation", async () => {
    const result = await runRepositoryQuery({ mode: "tree", maxResults: 2 }, createContext());
    expect(result).toMatchObject({ mode: "tree", success: true, truncated: true, nextOffset: 2 });
    expect((result.entries as unknown[]).length).toBe(2);
  });

  it("supports path and content search", async () => {
    const pathSearch = await runRepositoryQuery({
      mode: "search",
      searchIn: "path",
      patternType: "glob",
      query: "src/*.ts",
    }, createContext());
    expect(pathSearch.matches).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);

    const contentSearch = await runRepositoryQuery({
      mode: "search",
      query: "needle",
    }, createContext());
    expect(contentSearch).toMatchObject({ includesUntracked: true, total: 1 });
    expect(contentSearch.matches).toEqual([{ path: "src/a.ts", line: 2, text: "needle here" }]);
  });

  it("summarizes staged and unstaged changes with optional diff", async () => {
    const result = await runRepositoryQuery({ mode: "changes", includeDiff: true }, createContext());
    expect(result).toMatchObject({ mode: "changes", success: true, total: 2, diffTruncated: false });
    expect(result.diff).toContain("cached diff");
    expect(result.diff).toContain("working diff");
  });
});
