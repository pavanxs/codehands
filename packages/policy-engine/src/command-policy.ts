import * as path from "node:path";

const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "sh",
  "zsh",
]);

const PROTECTED_ENV_KEYS = new Set([
  "CODEX_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "PATHEXT",
  "PYTHONPATH",
  "SHELL",
  "SystemRoot",
  "USERPROFILE",
]);

export interface CommandPolicyOptions {
  allowedExecutables?: string[];
  allowedEnvironmentVariables?: string[];
  allowShell?: boolean;
}

export class CommandPolicy {
  private readonly allowedExecutables: Set<string> | null;
  private readonly allowedEnvironmentVariables: Set<string>;
  private readonly allowShell: boolean;

  constructor(options: CommandPolicyOptions = {}) {
    this.allowedExecutables = options.allowedExecutables?.length
      ? new Set(options.allowedExecutables.map(normalizeExecutable))
      : null;
    this.allowedEnvironmentVariables = new Set(options.allowedEnvironmentVariables ?? []);
    this.allowShell = options.allowShell ?? false;
  }

  validateExecutable(command: string): { allowed: boolean; reason?: string } {
    if (!command || command.includes("\0")) {
      return { allowed: false, reason: "Command must be a non-empty executable name or path" };
    }

    const executable = normalizeExecutable(command);
    if (!this.allowShell && SHELL_EXECUTABLES.has(executable)) {
      return {
        allowed: false,
        reason: `Shell executable "${executable}" is disabled. Enable allowShell explicitly if shell interpretation is required.`,
      };
    }

    if (this.allowedExecutables && !this.allowedExecutables.has(executable)) {
      return {
        allowed: false,
        reason: `Executable "${executable}" is not in the configured allowedExecutables list`,
      };
    }

    return { allowed: true };
  }

  validateEnvironment(env: Record<string, string> | undefined): { allowed: boolean; reason?: string } {
    if (!env) return { allowed: true };

    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
        return { allowed: false, reason: `Invalid environment override "${key}"` };
      }
      if (PROTECTED_ENV_KEYS.has(key) || !this.allowedEnvironmentVariables.has(key)) {
        return {
          allowed: false,
          reason: `Environment override "${key}" is not allowed by policy`,
        };
      }
    }

    return { allowed: true };
  }
}

function normalizeExecutable(command: string): string {
  return path.basename(command.replace(/\\/g, "/")).toLowerCase();
}
