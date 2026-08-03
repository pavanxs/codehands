import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceValidator } from "./workspace-validator.js";

const isWindows = process.platform === "win32";
const WORKSPACE_A = isWindows ? "C:\\Users\\dev\\project-a" : "/home/dev/project-a";
const WORKSPACE_B = isWindows ? "C:\\Users\\dev\\project-b" : "/home/dev/project-b";
const OUTSIDE = isWindows ? "C:\\Users\\dev\\secret" : "/home/dev/secret";
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("WorkspaceValidator", () => {
  const v = new WorkspaceValidator([WORKSPACE_A, WORKSPACE_B]);

  it("allows paths within approved workspace", () => {
    expect(v.validate(path.join(WORKSPACE_A, "src", "index.ts")).allowed).toBe(true);
  });

  it("allows workspace root itself", () => {
    expect(v.validate(WORKSPACE_A).allowed).toBe(true);
  });

  it("rejects paths outside all workspaces", () => {
    const result = v.validate(OUTSIDE);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside all approved workspaces");
  });

  it("rejects when no workspaces configured", () => {
    const result = new WorkspaceValidator([]).validate(WORKSPACE_A);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No workspaces configured");
  });

  it("rejects path traversal attempts", () => {
    const traversal = path.join(WORKSPACE_A, "..", "secret", "keys.txt");
    expect(v.validate(traversal).allowed).toBe(false);
  });

  it("returns a canonical resolved path", () => {
    const result = v.validate(path.join(WORKSPACE_A, "src", "..", "package.json"));
    expect(result.resolvedPath).toBe(path.resolve(WORKSPACE_A, "package.json"));
    expect(result.allowed).toBe(true);
  });

  it("rejects symlink or junction escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-workspace-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-outside-"));
    temporaryPaths.push(root, outside);

    const link = path.join(root, "escape");
    fs.symlinkSync(outside, link, isWindows ? "junction" : "dir");

    const result = new WorkspaceValidator([root]).validate(path.join(link, "secret.txt"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside all approved workspaces");
  });

  it("allows new files when their nearest existing parent is inside the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehands-workspace-"));
    temporaryPaths.push(root);

    const result = new WorkspaceValidator([root]).validate(path.join(root, "new", "file.txt"));
    expect(result.allowed).toBe(true);
  });
});

describe("WorkspaceValidator.resolvePath", () => {
  const v = new WorkspaceValidator([WORKSPACE_A]);

  it("resolves relative path from active workspace", () => {
    expect(v.resolvePath("src/index.ts", WORKSPACE_A)).toBe(path.resolve(WORKSPACE_A, "src/index.ts"));
  });

  it("returns absolute paths unchanged", () => {
    const absolute = isWindows ? "C:\\other\\file.txt" : "/other/file.txt";
    expect(v.resolvePath(absolute, WORKSPACE_A)).toBe(path.resolve(absolute));
  });

  it("throws on relative path without active workspace", () => {
    expect(() => v.resolvePath("src/index.ts", null)).toThrow("no active workspace set");
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
