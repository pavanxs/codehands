import { describe, expect, it, vi } from "vitest";
import type { CodexAdapter, ReadResponse } from "@codehands/codex-adapter";
import { ProcessRegistry } from "./process-registry.js";

function response(exited = false, exitCode?: number): ReadResponse {
  return { chunks: [], nextSeq: 1, exited, exitCode, closed: exited };
}

function adapter(generation: number, read: (id: string) => Promise<ReadResponse>): CodexAdapter {
  return {
    getGeneration: () => generation,
    processRead: vi.fn((params: { processId: string }) => read(params.processId)),
  } as unknown as CodexAdapter;
}

describe("ProcessRegistry", () => {
  it("reconciles an unknown process ID with the exec-server", async () => {
    const registry = new ProcessRegistry();
    const result = await registry.reconcile(adapter(1, async () => response(false)), "external-1", "s1");
    expect(result.found).toBe(true);
    expect(registry.get("external-1")?.status).toBe("running");
  });

  it("marks irrecoverable unknown IDs lost", async () => {
    const registry = new ProcessRegistry();
    const result = await registry.reconcile(adapter(1, async () => { throw new Error("unknown process"); }), "missing", "s1");
    expect(result.found).toBe(false);
    expect(registry.get("missing")?.status).toBe("lost");
  });

  it("marks old-generation processes stale then reconciles them after restart", async () => {
    const registry = new ProcessRegistry();
    registry.add("p1", { command: "node", startedAt: new Date().toISOString(), status: "running", sessionId: "s1", generation: 1 });
    registry.markGenerationStale(2);
    expect(registry.get("p1")?.status).toBe("stale");
    await registry.reconcileAll(adapter(2, async () => response(true, 0)), "s1");
    expect(registry.get("p1")?.status).toBe("exited");
    expect(registry.get("p1")?.exitCode).toBe(0);
  });

  it("caps retained terminal entries and expires old entries", () => {
    const registry = new ProcessRegistry({ maxRetained: 2, retentionMs: 1000 });
    const now = Date.now();
    for (let index = 0; index < 4; index++) {
      registry.add(`p${index}`, {
        command: "x", startedAt: new Date(now + index).toISOString(), completedAt: new Date(now + index).toISOString(),
        status: "exited", sessionId: "s", generation: 1,
      });
    }
    expect(registry.size()).toBe(2);
    registry.cleanup(now + 5000);
    expect(registry.size()).toBe(0);
  });

  it("retains recent output and terminal status transitions", () => {
    const registry = new ProcessRegistry({ recentOutputChars: 5 });
    registry.add("p", { command: "x", startedAt: new Date().toISOString(), status: "running", sessionId: "s", generation: 1 });
    registry.updateFromRead("p", response(true, 7), "123456");
    expect(registry.get("p")).toMatchObject({ status: "exited", exitCode: 7, recentOutput: "23456" });
  });
});
