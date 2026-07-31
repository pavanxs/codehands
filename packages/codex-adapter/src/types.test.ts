import { describe, expect, it } from "vitest";
import { createWorkspaceSandbox } from "./types.js";

describe("createWorkspaceSandbox", () => {
  it("creates a restricted workspace-write sandbox", () => {
    const sandbox = createWorkspaceSandbox("file:///workspace");
    expect(sandbox.permissions.type).toBe("managed");
    expect(sandbox.permissions.network).toBe("restricted");
    expect(sandbox.workspaceRoots).toEqual(["file:///workspace"]);
    expect(sandbox.windowsSandboxLevel).toBe("restricted-token");
    expect(sandbox.permissions.file_system.entries).toContainEqual({
      path: { type: "special", value: { kind: "project_roots" } },
      access: "write",
    });
  });

  it("can create a read-only workspace sandbox", () => {
    const sandbox = createWorkspaceSandbox("file:///workspace", { readOnly: true });
    expect(sandbox.permissions.file_system.entries).toContainEqual({
      path: { type: "special", value: { kind: "project_roots" } },
      access: "read",
    });
  });
});
