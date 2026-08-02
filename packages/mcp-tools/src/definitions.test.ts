import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./definitions.js";

describe("TOOL_DEFINITIONS", () => {
  it("has exactly 32 tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(32);
  });

  it("all names use only allowed MCP characters [A-Za-z0-9_-.]", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_\-.]+$/);
    }
  });

  it("no duplicate names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools have description and inputSchema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("contains the expected tool categories", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("fs_"))).toHaveLength(11);
    expect(names.filter((n) => n.startsWith("process_"))).toHaveLength(8);
    expect(names.filter((n) => n.startsWith("http_"))).toHaveLength(1);
    expect(names.filter((n) => n.startsWith("workspace_"))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith("agent_"))).toHaveLength(5);
    expect(names).toEqual(expect.arrayContaining([
      "process_run", "repo_snapshot", "fs_search", "fs_readRange", "fs_applyPatch",
      "test_run", "git_diff_summary", "agent_start", "agent_status", "agent_results",
      "agent_cancel", "agent_run_many",
    ]));
  });

  it("destructive tools are annotated", () => {
    const destructive = TOOL_DEFINITIONS.filter((t) => t.annotations?.destructiveHint);
    const names = destructive.map((t) => t.name);
    expect(names).toContain("fs_writeFile");
    expect(names).toContain("fs_remove");
    expect(names).toContain("process_start");
    expect(names).toContain("process_run");
    expect(names).toContain("fs_applyPatch");
    expect(names).toContain("agent_start");
    expect(names).toContain("process_terminate");
  });

  it("read-only tools are annotated", () => {
    const readOnly = TOOL_DEFINITIONS.filter((t) => t.annotations?.readOnlyHint);
    const names = readOnly.map((t) => t.name);
    expect(names).toContain("fs_readFile");
    expect(names).toContain("fs_readDirectory");
    expect(names).toContain("workspace_list");
    expect(names).toContain("repo_snapshot");
  });

  it("documents the exec-server fs_walk symlink field", () => {
    const walk = TOOL_DEFINITIONS.find((tool) => tool.name === "fs_walk")!;
    expect((walk.inputSchema.properties as Record<string, unknown>)).toHaveProperty("followDirectorySymlinks");
  });
});
