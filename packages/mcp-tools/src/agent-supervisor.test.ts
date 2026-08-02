import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAdapter, ReadResponse } from "@codehands/codex-adapter";
import { AgentRegistry, agentCancel, agentRunMany, agentStart, agentStatusTool } from "./agent-supervisor.js";
import type { ToolContext } from "./context.js";
import { ProcessRegistry } from "./process-registry.js";

function output(text = "", exitCode = 0): ReadResponse {
  return {
    chunks: text ? [{ seq: 1, stream: "stdout", chunk: Buffer.from(text).toString("base64") }] : [],
    nextSeq: 2,
    exited: true,
    closed: true,
    exitCode,
  };
}

function setup() {
  let sequence = 0;
  const reads = new Map<string, ReadResponse>();
  const adapter = {
    getGeneration: () => 1,
    processStart: vi.fn(async ({ argv }: { argv: string[] }) => {
      const processId = `p-${++sequence}`;
      if (argv[0] === "git") {
        const gitOutput = argv.includes("--show-toplevel")
          ? "/repo\n"
          : argv.includes("HEAD")
            ? "0123456789abcdef0123456789abcdef01234567\n"
            : "";
        reads.set(processId, output(gitOutput));
      }
      return { processId };
    }),
    processRead: vi.fn(async ({ processId }: { processId: string }) => reads.get(processId) ?? { chunks: [], nextSeq: 1, exited: false, closed: false }),
    processTerminate: vi.fn(async () => ({ running: true })),
  } as unknown as CodexAdapter;
  const root = path.resolve("/repo");
  const ctx: ToolContext = {
    adapter,
    activeWorkspace: root,
    workspaces: [root],
    resolvePath: (value) => path.resolve(root, value),
    processRegistry: new ProcessRegistry(),
    agentRegistry: new AgentRegistry(),
    sessionId: "s1",
    checkBlocked: () => null,
    allowShell: false,
    testCommands: {},
    codexBinary: "configured-codex",
    allowedAgentModels: ["approved-model"],
  };
  return { adapter, ctx, reads };
}

describe("explicit Codex worker supervisor", () => {
  it("creates a unique worktree/branch and launches configured Codex with safe options", async () => {
    const { adapter, ctx } = setup();
    const result = await agentStart({ task: "Implement the explicit task", model: "approved-model", sandbox: "workspace-write" }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("running");
    expect(result.branch).toMatch(/^codehands\/agent-/);
    expect(result.worktree).toContain("/.codehands/worktrees/agent-");
    const calls = vi.mocked(adapter.processStart).mock.calls.map((call) => call[0].argv);
    expect(calls.some((argv) => argv.includes("worktree") && argv.includes("add"))).toBe(true);
    const codexCall = calls.find((argv) => argv[0] === "configured-codex");
    expect(codexCall).toEqual(expect.arrayContaining([
      "--ask-for-approval", "never",
      "exec",
      "--sandbox", "workspace-write",
      "--ephemeral",
      "--color", "never",
      "--model", "approved-model",
    ]));
    expect(codexCall?.at(-1)).toContain("Implement the explicit task");
    expect(codexCall?.at(-1)).toContain("Do not commit, merge, push, deploy, or delete branches");
  });

  it("rejects unsafe branch, sandbox, and unapproved explicit model values", async () => {
    const one = setup();
    await expect(agentStart({ task: "x", branch: "../bad" }, one.ctx)).rejects.toThrow("Invalid branch");
    const two = setup();
    await expect(agentStart({ task: "x", sandbox: "danger-full-access" }, two.ctx)).rejects.toThrow("Unsafe sandbox");
    const three = setup();
    await expect(agentStart({ task: "x", model: "not-approved" }, three.ctx)).rejects.toThrow("agentModels");
  });

  it("reports completion and never merges, pushes, or deploys", async () => {
    const { adapter, ctx, reads } = setup();
    const started = await agentStart({ task: "finish" }, ctx) as { agentId: string; processId: string };
    reads.set(started.processId, output("done", 0));
    const status = await agentStatusTool({ agentId: started.agentId }, ctx) as Record<string, unknown>;
    expect(status).toMatchObject({ status: "completed", exitCode: 0 });
    const allArgv = vi.mocked(adapter.processStart).mock.calls.flatMap((call) => call[0].argv);
    expect(allArgv).not.toContain("merge");
    expect(allArgv).not.toContain("push");
    expect(allArgv).not.toContain("deploy");
  });

  it("cancels a worker and cleans worktree only when requested", async () => {
    const { adapter, ctx } = setup();
    const started = await agentStart({ task: "wait" }, ctx) as { agentId: string };
    const cancelled = await agentCancel({ agentId: started.agentId, cleanup: false }, ctx) as Record<string, unknown>;
    expect(cancelled).toMatchObject({ status: "cancelled", cleanupRequested: false, cleaned: false });
    expect(adapter.processTerminate).toHaveBeenCalledOnce();
  });

  it("enforces the hard parallel worker cap without model calls", async () => {
    const { ctx } = setup();
    await expect(agentRunMany({ tasks: Array.from({ length: 5 }, () => ({ task: "x" })) }, ctx)).rejects.toThrow("limited to 4");
  });
});
