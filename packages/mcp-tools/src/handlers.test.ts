import { describe, expect, it, vi } from "vitest";
import type { CodexAdapter } from "@codehands/codex-adapter";
import { getHandler, type ToolContext } from "./handlers.js";

describe("process_start argument handling", () => {
  function makeContext(processStart: ReturnType<typeof vi.fn>): ToolContext {
    return {
      adapter: { processStart } as unknown as CodexAdapter,
      activeWorkspace: "/tmp/codehands-project",
      workspaces: ["/tmp/codehands-project"],
      resolvePath: (value) => value,
      ownedProcesses: new Map(),
      sessionId: "test-session",
    };
  }

  it("passes separate arguments directly without flattening values containing spaces", async () => {
    const processStart = vi.fn().mockResolvedValue({ processId: "proc-1" });
    const handler = getHandler("process_start");
    expect(handler).toBeDefined();

    await handler!({
      command: "git",
      args: ["commit", "--amend", "-m", "title containing spaces"],
    }, makeContext(processStart));

    expect(processStart).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["git", "commit", "--amend", "-m", "title containing spaces"],
    }));
  });

  it("uses a shell only for the legacy single command-string form", async () => {
    const processStart = vi.fn().mockResolvedValue({ processId: "proc-2" });
    const handler = getHandler("process_start");

    await handler!({ command: "echo hello" }, makeContext(processStart));

    expect(processStart).toHaveBeenCalledWith(expect.objectContaining({
      argv: process.platform === "win32"
        ? ["cmd.exe", "/c", "echo hello"]
        : ["/bin/sh", "-c", "echo hello"],
    }));
  });
});
