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
  private defaultsEnabled: boolean;

  constructor(config: BlockedCommandsConfig = {}) {
    this.defaultsEnabled = !(config.disableDefaults ?? false);
    const base = config.disableDefaults ? [] : DEFAULT_BLOCKED_PATTERNS;
    const extra = (config.extraPatterns ?? []).map((p) => new RegExp(p, "i"));
    this.patterns = [...base, ...extra];
  }

  isBlocked(argv: string[]): { blocked: boolean; reason?: string } {
    const commandLine = argv.join(" ");
    const executable = path.basename((argv[0] ?? "").replace(/\\/g, "/")).toLowerCase();
    if (this.defaultsEnabled && executable === "rm") {
      const flags = argv.slice(1).filter((arg) => arg.startsWith("-"));
      const recursive = flags.some((flag) => flag === "--recursive" || /^-[^-]*r/i.test(flag));
      const force = flags.some((flag) => flag === "--force" || /^-[^-]*f/i.test(flag));
      const absoluteTarget = argv.slice(1).some((arg) => !arg.startsWith("-") && path.isAbsolute(arg));
      if (recursive && force && absoluteTarget) {
        return {
          blocked: true,
          reason: "Command blocked by safety policy: recursive forced removal of an absolute path",
        };
      }
    }

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
  return [command, ...args];
}
