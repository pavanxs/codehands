import * as path from "node:path";

export class WorkspaceValidator {
  private workspaces: string[];

  constructor(workspaces: string[]) {
    this.workspaces = workspaces.map((w) => path.resolve(w));
  }

  updateWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces.map((w) => path.resolve(w));
  }

  getWorkspaces(): string[] {
    return [...this.workspaces];
  }

  validate(filePath: string): { allowed: boolean; resolvedPath: string; reason?: string } {
    const resolved = path.resolve(filePath);

    if (this.workspaces.length === 0) {
      return {
        allowed: false,
        resolvedPath: resolved,
        reason: "No workspaces configured. Add workspaces to ~/.codehands/config.json",
      };
    }

    const isWithin = this.workspaces.some(
      (ws) => resolved === ws || resolved.startsWith(ws + path.sep),
    );

    if (!isWithin) {
      return {
        allowed: false,
        resolvedPath: resolved,
        reason: `Path "${resolved}" is outside all approved workspaces`,
      };
    }

    return { allowed: true, resolvedPath: resolved };
  }

  resolvePath(relativePath: string, activeWorkspace: string | null): string {
    if (path.isAbsolute(relativePath)) return path.resolve(relativePath);
    if (!activeWorkspace) {
      throw new Error("Cannot resolve relative path: no active workspace set");
    }
    return path.resolve(activeWorkspace, relativePath);
  }
}
