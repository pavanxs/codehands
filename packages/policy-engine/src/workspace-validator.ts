import * as fs from "node:fs";
import * as path from "node:path";

export interface PathValidationResult {
  allowed: boolean;
  resolvedPath: string;
  reason?: string;
}

function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const missingParts: string[] = [];
  let existingPath = resolved;

  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    missingParts.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  const canonicalBase = fs.existsSync(existingPath)
    ? fs.realpathSync.native(existingPath)
    : existingPath;

  return path.resolve(canonicalBase, ...missingParts);
}

function isPathWithin(candidate: string, workspace: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class WorkspaceValidator {
  private workspaces: string[];

  constructor(workspaces: string[]) {
    this.workspaces = workspaces.map(canonicalizePath);
  }

  updateWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces.map(canonicalizePath);
  }

  getWorkspaces(): string[] {
    return [...this.workspaces];
  }

  validate(filePath: string): PathValidationResult {
    const resolved = canonicalizePath(filePath);

    if (this.workspaces.length === 0) {
      return {
        allowed: false,
        resolvedPath: resolved,
        reason: "No workspaces configured. Add workspaces to ~/.codehands/config.json",
      };
    }

    if (!this.workspaces.some((workspace) => isPathWithin(resolved, workspace))) {
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
