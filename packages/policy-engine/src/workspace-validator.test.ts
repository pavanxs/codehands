import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { WorkspaceValidator } from "./workspace-validator.js";

const isWindows = process.platform === "win32";

const WORKSPACE_A = isWindows ? "C:\\Users\\dev\\project-a" : "/home/dev/project-a";
const WORKSPACE_B = isWindows ? "C:\\Users\\dev\\project-b" : "/home/dev/project-b";
const OUTSIDE = isWindows ? "C:\\Users\\dev\\secret" : "/home/dev/secret";

describe("WorkspaceValidator", () => {
  const v = new WorkspaceValidator([WORKSPACE_A, WORKSPACE_B]);

  it("allows paths within approved workspace", () => {
    const filePath = path.join(WORKSPACE_A, "src", "index.ts");
    const result = v.validate(filePath);
    expect(result.allowed).toBe(true);
  });

  it("allows workspace root itself", () => {
    const result = v.validate(WORKSPACE_A);
    expect(result.allowed).toBe(true);
  });

  it("rejects paths outside all workspaces", () => {
    const result = v.validate(OUTSIDE);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside all approved workspaces");
  });

  it("rejects when no workspaces configured", () => {
    const empty = new WorkspaceValidator([]);
    const result = empty.validate(WORKSPACE_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No workspaces configured");
  });

  it("rejects path traversal attempts", () => {
    const traversal = path.join(WORKSPACE_A, "..", "secret", "keys.txt");
    const result = v.validate(traversal);
    expect(result.allowed).toBe(false);
  });

  it("returns resolved path", () => {
    const relative = path.join(WORKSPACE_A, "src", "..", "package.json");
    const result = v.validate(relative);
    expect(result.resolvedPath).toBe(path.resolve(WORKSPACE_A, "package.json"));
    expect(result.allowed).toBe(true);
  });
});

describe("WorkspaceValidator.resolvePath", () => {
  const v = new WorkspaceValidator([WORKSPACE_A]);

  it("resolves relative path from active workspace", () => {
    const result = v.resolvePath("src/index.ts", WORKSPACE_A);
    expect(result).toBe(path.resolve(WORKSPACE_A, "src/index.ts"));
  });

  it("returns absolute paths unchanged", () => {
    const absPath = isWindows ? "C:\\other\\file.txt" : "/other/file.txt";
    const result = v.resolvePath(absPath, WORKSPACE_A);
    expect(result).toBe(path.resolve(absPath));
  });

  it("throws on relative path without active workspace", () => {
    expect(() => v.resolvePath("src/index.ts", null)).toThrow(
      "no active workspace set",
    );
  });
});

describe("WorkspaceValidator.updateWorkspaces", () => {
  it("dynamically adds new workspaces", () => {
    const v = new WorkspaceValidator([WORKSPACE_A]);
    expect(v.validate(path.join(WORKSPACE_B, "file.ts")).allowed).toBe(false);

    v.updateWorkspaces([WORKSPACE_A, WORKSPACE_B]);
    expect(v.validate(path.join(WORKSPACE_B, "file.ts")).allowed).toBe(true);
  });
});
