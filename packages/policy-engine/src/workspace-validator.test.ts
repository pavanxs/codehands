import { afterAll, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceValidator } from "./workspace-validator.js";

const isWindows = process.platform === "win32";
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-workspace-"));
const WORKSPACE_A = path.join(TEST_ROOT, "project-a");
const WORKSPACE_B = path.join(TEST_ROOT, "project-b");
const OUTSIDE = path.join(TEST_ROOT, "secret");
fs.mkdirSync(WORKSPACE_A);
fs.mkdirSync(WORKSPACE_B);
fs.mkdirSync(OUTSIDE);

afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

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
    expect(result.resolvedPath).toBe(path.join(fs.realpathSync.native(WORKSPACE_A), "package.json"));
    expect(result.allowed).toBe(true);
  });

  it.skipIf(isWindows)("rejects a symlink that escapes the approved workspace", () => {
    const secret = path.join(OUTSIDE, "secret.txt");
    fs.writeFileSync(secret, "not in workspace");
    fs.symlinkSync(OUTSIDE, path.join(WORKSPACE_A, "escape"));

    const result = v.validate(path.join(WORKSPACE_A, "escape", "secret.txt"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("symlink escape");
  });

  it.skipIf(isWindows)("rejects a create beneath a symlink that escapes the workspace", () => {
    const link = path.join(WORKSPACE_A, "create-escape");
    fs.symlinkSync(OUTSIDE, link);
    const result = v.validate(path.join(link, "new.txt"));
    expect(result.allowed).toBe(false);
  });
});

describe("WorkspaceValidator.resolvePath", () => {
  const v = new WorkspaceValidator([WORKSPACE_A]);

  it("resolves relative path from active workspace", () => {
    const result = v.resolvePath("src/index.ts", WORKSPACE_A);
    expect(result).toBe(path.resolve(WORKSPACE_A, "src/index.ts"));
  });

  it("returns absolute paths unchanged", () => {
    const absPath = path.join(OUTSIDE, "file.txt");
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
