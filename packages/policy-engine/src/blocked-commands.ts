import * as path from "node:path";

const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*\s+)*-rf?\s+[/\\]/i,
  /\brm\s+(-\w*\s+)*-fr?\s+[/\\]/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of\s*=\s*\/dev\//i,
  /\b(chmod|chown)\s+(-\w+\s+)*777\s+[/\\]/i,
  /\b>\s*\/dev\/sd[a-z]/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\breg\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bsfc\s+\/scannow\b/i,
  /\bbcdedit\b/i,
];

export interface BlockedCommandsConfig {
  extraPatterns?: string[];
  disableDefaults?: boolean;
}

export class BlockedCommands {
  private patterns: RegExp[];

  constructor(config: BlockedCommandsConfig = {}) {
    const base = config.disableDefaults ? [] : DEFAULT_BLOCKED_PATTERNS;
    const extra = (config.extraPatterns ?? []).map((p) => new RegExp(p, "i"));
    this.patterns = [...base, ...extra];
  }

  isBlocked(argv: string[]): { blocked: boolean; reason?: string } {
    const commandLine = argv.join(" ");

    for (const pattern of this.patterns) {
      if (pattern.test(commandLine)) {
        return {
          blocked: true,
          reason: `Command blocked by safety policy: matches pattern ${pattern.source}`,
        };
      }
    }

    return { blocked: false };
  }
}

export function normalizeArgv(command: string, args: string[] = []): string[] {
  if (args.length > 0) return [command, ...args];

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const flag = isWindows ? "/c" : "-c";
  return [shell, flag, command];
}
