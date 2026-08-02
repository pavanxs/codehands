import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandPathValidationOptions {
  command: string;
  args?: string[];
  cwd: string;
  workspace: string;
  /** Zero-based argv entries known to be data (for example a prompt), never paths. */
  nonPathArgumentIndexes?: Iterable<number>;
}

export interface CommandPathValidationResult {
  allowed: boolean;
  reason?: string;
}

function normalizedForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizedForComparison(candidate);
  const normalizedRoot = normalizedForComparison(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function looksLikeNonFileUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/^file:\/\//i.test(value);
}

function looksLikeRegexLiteral(value: string): boolean {
  return value.length > 2
    && value.startsWith("/")
    && /\/[a-z]*$/i.test(value)
    && /[?+*|()[\]{}^$]/.test(value.slice(1, value.lastIndexOf("/")));
}

function unwrapValue(raw: string): string {
  let value = raw;
  const flagAssignment = /^-{1,2}[^=:\s]+[=:](.+)$/.exec(value);
  if (flagAssignment) value = flagAssignment[1]!;
  else {
    const environmentAssignment = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(value);
    if (environmentAssignment) value = environmentAssignment[1]!;
  }
  if (value.startsWith("!") && value.length > 1) value = value.slice(1);
  return value;
}

function candidatePath(raw: string, cwd: string): string | null {
  const value = unwrapValue(raw);
  if (!value || looksLikeNonFileUrl(value)) return null;

  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return value;
    }
  }

  if (path.isAbsolute(value)) return path.resolve(value);
  if (path.win32.isAbsolute(value)) return value;
  if (/^~(?:[\\/]|$)/.test(value)) return value;
  if (looksLikeRegexLiteral(value)) return null;

  const portable = value.replace(/[\\/]/g, path.sep);
  const segments = portable.split(path.sep);
  if (!segments.includes("..")) return null;
  return path.resolve(cwd, portable);
}

/**
 * Conservatively confines path-bearing argv entries to one approved workspace.
 * It is lexical by design: shell script text is outside this validator's scope.
 */
export function validateCommandPaths(options: CommandPathValidationOptions): CommandPathValidationResult {
  const workspace = path.resolve(options.workspace);
  const cwd = path.resolve(options.cwd);
  if (!isWithin(cwd, workspace)) {
    return { allowed: false, reason: `Command cwd "${cwd}" is outside the active workspace "${workspace}"` };
  }

  const skipped = new Set(options.nonPathArgumentIndexes ?? []);
  for (const [index, raw] of (options.args ?? []).entries()) {
    if (skipped.has(index) || (!raw.includes("=") && raw.startsWith("-"))) continue;
    const candidate = candidatePath(raw, cwd);
    if (!candidate) continue;
    if (/^~(?:[\\/]|$)/.test(candidate)) {
      return { allowed: false, reason: `Command argument ${index + 1} references a path outside the active workspace: ${raw}` };
    }
    if (!path.isAbsolute(candidate) || !isWithin(candidate, workspace)) {
      return { allowed: false, reason: `Command argument ${index + 1} references a path outside the active workspace: ${raw}` };
    }
  }
  return { allowed: true };
}
