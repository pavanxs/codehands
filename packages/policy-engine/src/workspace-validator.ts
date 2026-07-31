import * as fs from "node:fs";
import * as path from "node:path";

export class WorkspaceValidator {
  private workspaces: string[];
  private canonicalWorkspaces: Map<string, string>;

  constructor(workspaces: string[]) {
    this.workspaces = workspaces.map((w) => path.resolve(w));
    this.canonicalWorkspaces = this.buildCanonicalWorkspaceMap(this.workspaces);
  }

  updateWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces.map((w) => path.resolve(w));
    this.canonicalWorkspaces = this.buildCanonicalWorkspaceMap(this.workspaces);
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

    const lexicalWorkspace = this.workspaces.find((workspace) => isWithin(workspace, resolved));
    if (!lexicalWorkspace) {
      return {
        allowed: false,
        resolvedPath: resolved,
        reason: `Path "${resolved}" is outside all approved workspaces`,
      };
    }

    try {
      const canonicalWorkspace = this.canonicalWorkspaces.get(lexicalWorkspace)!;
      const canonicalTarget = canonicalizeTarget(resolved);
      if (!isWithin(canonicalWorkspace, canonicalTarget)) {
        return {
          allowed: false,
          resolvedPath: canonicalTarget,
          reason: `Path "${resolved}" resolves outside its approved workspace (possible symlink escape)`,
        };
      }
      return { allowed: true, resolvedPath: canonicalTarget };
    } catch (err) {
      return {
        allowed: false,
        resolvedPath: resolved,
        reason: `Unable to safely resolve path "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  validateInWorkspace(
    filePath: string,
    workspace: string | null,
  ): { allowed: boolean; resolvedPath: string; reason?: string } {
    const check = this.validate(filePath);
    if (!check.allowed || !workspace) return check;

    const workspaceCheck = this.validate(workspace);
    if (!workspaceCheck.allowed || !isWithin(workspaceCheck.resolvedPath, check.resolvedPath)) {
      return {
        allowed: false,
        resolvedPath: check.resolvedPath,
        reason: `Path "${check.resolvedPath}" is outside the active workspace`,
      };
    }
    return check;
  }

  resolvePath(relativePath: string, activeWorkspace: string | null): string {
    if (path.isAbsolute(relativePath)) return path.resolve(relativePath);
    if (!activeWorkspace) {
      throw new Error("Cannot resolve relative path: no active workspace set");
    }
    return path.resolve(activeWorkspace, relativePath);
  }

  private buildCanonicalWorkspaceMap(workspaces: string[]): Map<string, string> {
    return new Map(workspaces.map((workspace) => {
      const canonical = fs.existsSync(workspace) ? fs.realpathSync.native(workspace) : workspace;
      return [workspace, canonical];
    }));
  }
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedCandidate = normalizeForComparison(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve every existing path component through the filesystem. For a target
 * that does not exist yet, resolve its deepest existing parent and append only
 * the missing suffix. This prevents an in-workspace symlink from redirecting a
 * read or write outside the approved root.
 */
function canonicalizeTarget(target: string): string {
  if (fs.existsSync(target)) {
    return fs.realpathSync.native(target);
  }

  const missing: string[] = [];
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("no existing ancestor");
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  return path.resolve(fs.realpathSync.native(ancestor), ...missing);
}
