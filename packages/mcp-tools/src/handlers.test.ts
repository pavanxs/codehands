import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAdapter, ReadResponse } from "@codehands/codex-adapter";
import { AgentRegistry } from "./agent-supervisor.js";
import type { ToolContext } from "./context.js";
import { getHandler } from "./handlers.js";
import { ProcessRegistry } from "./process-registry.js";

function chunk(text: string, stream: "stdout" | "stderr" = "stdout", seq = 1) {
  return { seq, stream, chunk: Buffer.from(text).toString("base64") };
}

function read(stdout = "", exitCode = 0, stream: "stdout" | "stderr" = "stdout"): ReadResponse {
  return { chunks: stdout ? [chunk(stdout, stream)] : [], nextSeq: 2, exited: true, closed: true, exitCode };
}

function makeContext(adapter: Partial<CodexAdapter>, overrides: Partial<ToolContext> = {}): ToolContext {
  const root = path.resolve("/repo");
  return {
    adapter: { getGeneration: () => 1, ...adapter } as CodexAdapter,
    activeWorkspace: root,
    workspaces: [root],
    resolvePath: (value) => path.resolve(root, value),
    processRegistry: new ProcessRegistry(),
    agentRegistry: new AgentRegistry(),
    sessionId: "session-1",
    checkBlocked: () => null,
    allowShell: false,
    testCommands: {},
    codexBinary: "codex-custom",
    allowedAgentModels: [],
    ...overrides,
  };
}

async function call(name: string, params: Record<string, unknown>, ctx: ToolContext) {
  const result = await getHandler(name)!(params, ctx);
  return { result, data: result.isError ? undefined : JSON.parse(result.content[0]!.text) as Record<string, any> };
}

function commandAdapter(): CodexAdapter {
  let id = 0;
  const outputs = new Map<string, ReadResponse>();
  return {
    getGeneration: () => 1,
    processStart: vi.fn(async ({ argv }: { argv: string[] }) => {
      const processId = `p-${++id}`;
      let output = "";
      if (argv.includes("--show-toplevel")) output = "/repo\n";
      else if (argv.includes("--show-current")) output = "feat/test\n";
      else if (argv.includes("--short=12")) output = "abc123\n";
      else if (argv.includes("remote")) output = "origin\thttps://example.test/repo (fetch)\n";
      else if (argv[0] === "rg") output = "src/a.ts:1:1:needle\nsrc/b.ts:2:1:needle\n";
      else if (argv.includes("--stat")) output = "1 file changed\n";
      else if (argv.includes("--name-status")) output = "M\tsrc/a.ts\n";
      outputs.set(processId, read(output));
      return { processId };
    }),
    processRead: vi.fn(async ({ processId }: { processId: string }) => outputs.get(processId) ?? read()),
    processTerminate: vi.fn(async () => ({ running: true })),
    fsReadDirectory: vi.fn(async () => ({ entries: [{ fileName: "package.json", isFile: true, isDirectory: false }] })),
    fsReadFile: vi.fn(async () => ({ dataBase64: Buffer.from(JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } })).toString("base64") })),
    fsCreateDirectory: vi.fn(async () => ({})),
    fsWriteFile: vi.fn(async () => ({})),
    fsRemove: vi.fn(async () => ({})),
  } as unknown as CodexAdapter;
}

describe("process handlers", () => {
  it("sends paths, spaces, quotes, parentheses, pipes and metacharacters as literal argv", async () => {
    const processStart = vi.fn(async () => ({ processId: "p1" }));
    const ctx = makeContext({ processStart });
    const args = ["a b", "folder (one)", "x|y", "'quoted'", "$(touch SHOULD_NOT_EXIST)", "; false"];
    await call("process_start", { command: "/tool path/bin", args }, ctx);
    expect(processStart).toHaveBeenCalledWith(expect.objectContaining({ argv: ["/tool path/bin", ...args] }));
    expect(processStart.mock.calls[0]![0].argv[0]).not.toMatch(/sh|cmd\.exe/);
  });

  it("requires explicit config opt-in for shell execution", async () => {
    const ctx = makeContext({ processStart: vi.fn() });
    const { result } = await call("process_startShell", { script: "echo yes | wc" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("allowShell");
  });

  it("runs a finite command in one call with bounded stdout/stderr and exit code", async () => {
    const reads = [
      { chunks: [chunk("hello")], nextSeq: 2, exited: false, closed: false },
      { chunks: [chunk("warning", "stderr", 2)], nextSeq: 3, exited: true, closed: true, exitCode: 0 },
    ];
    const ctx = makeContext({ processStart: vi.fn(async () => ({ processId: "p1" })), processRead: vi.fn(async () => reads.shift()!) });
    const { data } = await call("process_run", { command: "node", args: ["script.js"], maxOutputBytes: 8 }, ctx);
    expect(data).toMatchObject({ exitCode: 0, exited: true, timedOut: false, stdout: "hello", stderr: "war" });
    expect(data.output).toMatchObject({ truncated: true, bytesReturned: 8, totalBytes: 12 });
  });

  it("paginates and filters compact process summaries", async () => {
    const ctx = makeContext({ processRead: vi.fn() });
    for (let index = 0; index < 3; index++) {
      ctx.processRegistry.add(`p${index}`, { command: `cmd ${index}`, startedAt: new Date(1000 + index).toISOString(), completedAt: new Date().toISOString(), status: "exited", exitCode: index, sessionId: "session-1", generation: 1 });
    }
    const { data } = await call("process_list", { status: "exited", offset: 1, limit: 1 }, ctx);
    expect(data).toMatchObject({ total: 3, offset: 1, limit: 1, hasMore: true });
    expect(data.processes).toHaveLength(1);
    expect(data.processes[0]).not.toHaveProperty("recentOutput");
  });
});

describe("bounded repository tools", () => {
  it("reads numbered line ranges", async () => {
    const ctx = makeContext({ fsReadFile: vi.fn(async () => ({ dataBase64: Buffer.from("one\ntwo\nthree").toString("base64") })) });
    const { data } = await call("fs_readRange", { path: "a.txt", startLine: 2, endLine: 3 }, ctx);
    expect(data.content).toBe("2: two\n3: three");
  });

  it("searches with bounded include/exclude args and result limits", async () => {
    const adapter = commandAdapter();
    const ctx = makeContext(adapter);
    const { data } = await call("fs_search", { query: "needle", include: ["*.ts"], exclude: ["dist/**"], limit: 1 }, ctx);
    expect(data.results).toEqual(["src/a.ts:1:1:needle"]);
    expect(data.output.truncated).toBe(true);
    expect(adapter.processStart).toHaveBeenCalledWith(expect.objectContaining({ argv: expect.arrayContaining(["rg", "--fixed-strings", "needle", "--glob", "*.ts", "!dist/**"]) }));
  });

  it("returns a repository snapshot with package and test hints", async () => {
    const { data } = await call("repo_snapshot", {}, makeContext(commandAdapter()));
    expect(data).toMatchObject({ repository: "/repo", branch: "feat/test", head: "abc123", packageHints: ["package.json"] });
    expect(data.testHints).toEqual(["test", "lint"]);
  });

  it("checks and applies safe unified patches through adapter operations", async () => {
    const adapter = commandAdapter();
    const ctx = makeContext(adapter);
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const { data } = await call("fs_applyPatch", { patch, dryRun: true }, ctx);
    expect(data).toMatchObject({ valid: true, applied: false, dryRun: true });
    expect(adapter.fsWriteFile).toHaveBeenCalledOnce();
    expect(adapter.fsRemove).toHaveBeenCalledOnce();
    expect(adapter.processStart).toHaveBeenCalledWith(expect.objectContaining({ argv: expect.arrayContaining(["apply", "--check"]) }));
  });

  it("runs only configured test commands", async () => {
    const adapter = commandAdapter();
    const ctx = makeContext(adapter, { testCommands: { unit: { command: "pnpm", args: ["test"] } } });
    const { data } = await call("test_run", { name: "unit" }, ctx);
    expect(data).toMatchObject({ name: "unit", passed: true, exitCode: 0 });
  });

  it("summarizes Git status, stats, and changed files", async () => {
    const { data } = await call("git_diff_summary", { baseRef: "main" }, makeContext(commandAdapter()));
    expect(data.stat).toContain("1 file changed");
    expect(data.files).toEqual(["M\tsrc/a.ts"]);
  });
});
