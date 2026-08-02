import * as path from "node:path";

const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  // ── Destructive file operations ──
  /\brm\s+(-\w*\s+)*-rf?\s+[/\\]/i,
  /\brm\s+(-\w*\s+)*-fr?\s+[/\\]/i,
  /\brm\s+(-\w*\s+)*-rf?\s+~/i,
  /\brm\s+(-\w*\s+)*-rf?\s+\*/i,
  /\brm\s+(-\w*\s+)*-rf?\s+\.\./i,
  /\brmdir\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,
  /\bdel\s+\/[sfq]+\s+[a-zA-Z]:\\/i,

  // ── Disk/partition destruction ──
  /\bformat\s+[a-zA-Z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+.*of\s*=\s*\/dev\//i,
  /\b>\s*\/dev\/sd[a-z]/i,
  /\bdiskpart\b/i,
  /\bfdisk\b/i,
  /\bparted\b/i,

  // ── System shutdown/reboot ──
  /\b(shutdown|reboot|halt|poweroff)\b/i,

  // ── Windows registry/system ──
  /\breg\s+delete\b/i,
  /\bsfc\s+\/scannow\b/i,
  /\bbcdedit\b/i,
  /\bwmic\s+os\s+.*delete\b/i,
  /\bnet\s+user\s+.*\/delete\b/i,
  /\bnet\s+stop\b/i,
  /\bsc\s+delete\b/i,

  // ── Dangerous permission changes ──
  /\b(chmod|chown)\s+(-\w+\s+)*777\s+[/\\]/i,
  /\bchmod\s+(-\w+\s+)*777\s+~/i,
  /\bicacls\s+.*\/grant\s+everyone/i,
  /\btakeown\s+\/f\s+[a-zA-Z]:\\/i,

  // ── Fork bombs and resource abuse ──
  /:\(\)\{\s*:\|:\s*&\s*\};:/,
  /\bfork\s*bomb\b/i,
  /\bwhile\s+true.*do.*done/i,

  // ── Network attacks ──
  /\bnmap\b/i,
  /\bnetcat\b.*-[el]/i,
  /\bnc\s+-[el]/i,
  /\biptables\s+-F\b/i,
  /\bnetsh\s+firewall\b/i,
  /\bnetsh\s+advfirewall\s+reset\b/i,

  // ── Credential/key theft ──
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
  /\bcat\s+.*\.ssh\/id_/i,
  /\bcat\s+.*\/etc\/shadow\b/i,
  /\bcat\s+.*\.env\b/i,
  /\bprintenv\b/i,

  // ── Package manager system-wide installs (risky) ──
  /\bpip\s+install\s+--system\b/i,
  /\bapt\s+(remove|purge)\b/i,
  /\byum\s+(remove|erase)\b/i,

  // ── Git force operations on remote ──
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+-f\b/i,

  // ── Docker system-level access ──
  /\bdocker\s+rm\s+-f\s+\$\(docker\s+ps/i,
  /\bdocker\s+system\s+prune\s+-a/i,
  /\bdocker\s+run\b.*--privileged\b/i,

  // ── Crypto miners / malware download ──
  /\bxmrig\b/i,
  /\bcryptominer\b/i,
  /\bcoinhive\b/i,
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
  return [command, ...args];
}

/** Build argv for the explicit shell tool. Never use this for direct commands. */
export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command];
}
