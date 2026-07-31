import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  error?: string;
  resultSummary?: string;
}

export interface AuditLoggerOptions {
  logDir?: string;
  enabled?: boolean;
  redactContent?: boolean;
}

export class AuditLogger {
  private logDir: string;
  private enabled: boolean;
  private redactContent: boolean;
  private stream: fs.WriteStream | null = null;
  private currentDate: string = "";
  private recentEntries: AuditEntry[] = [];
  private readonly recentLimit = 200;

  constructor(options: AuditLoggerOptions = {}) {
    this.logDir = options.logDir ?? path.join(os.homedir(), ".codehands", "logs");
    this.enabled = options.enabled ?? true;
    this.redactContent = options.redactContent ?? true;
  }

  log(entry: AuditEntry): void {
    if (!this.enabled) return;

    const sanitized = this.redactContent ? this.redact(entry) : structuredClone(entry);
    const line = JSON.stringify(sanitized) + "\n";

    this.recentEntries.push(sanitized);
    if (this.recentEntries.length > this.recentLimit) {
      this.recentEntries.splice(0, this.recentEntries.length - this.recentLimit);
    }

    const stream = this.getStream();
    stream.write(line);
  }

  recent(sessionId?: string, limit = 20): AuditEntry[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const entries = sessionId
      ? this.recentEntries.filter((entry) => entry.sessionId === sessionId)
      : this.recentEntries;
    return entries.slice(-boundedLimit).map((entry) => structuredClone(entry));
  }

  async close(): Promise<void> {
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
      this.stream = null;
    }
  }

  private getStream(): fs.WriteStream {
    const today = new Date().toISOString().slice(0, 10);

    if (this.stream && this.currentDate === today) {
      return this.stream;
    }

    if (this.stream) {
      this.stream.end();
    }

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.logDir, 0o700);

    this.currentDate = today;
    const logPath = path.join(this.logDir, `${today}.jsonl`);
    this.stream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    return this.stream;
  }

  private redact(entry: AuditEntry): AuditEntry {
    return {
      ...entry,
      params: sanitizeRecord(entry.params),
      error: entry.error ? redactSecretsInText(entry.error) : undefined,
      resultSummary: entry.resultSummary ? redactSecretsInText(entry.resultSummary) : undefined,
    };
  }
}

const SECRET_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|private[-_]?key)/i;
const CONTENT_KEY = /^(body|content|dataBase64|input)$/i;

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEY.test(key) || key === "env" || key === "headers") {
      sanitized[key] = "[redacted]";
    } else if (CONTENT_KEY.test(key)) {
      sanitized[key] = typeof value === "string" ? `[${value.length} chars]` : "[redacted]";
    } else if (key === "args" && Array.isArray(value)) {
      sanitized[key] = redactCommandArgs(value);
    } else {
      sanitized[key] = sanitizeUnknown(value);
    }
  }
  return sanitized;
}

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === "object") return sanitizeRecord(value as Record<string, unknown>);
  if (typeof value === "string") return redactSecretsInText(value);
  return value;
}

function redactCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((value) => {
    if (redactNext) {
      redactNext = false;
      return "[redacted]";
    }
    if (typeof value !== "string") return sanitizeUnknown(value);
    if (/^--?(token|password|secret|api[-_]?key)$/i.test(value)) {
      redactNext = true;
      return value;
    }
    if (/^--?(token|password|secret|api[-_]?key)=/i.test(value)) {
      return `${value.split("=")[0]}=[redacted]`;
    }
    return redactSecretsInText(value);
  });
}

function redactSecretsInText(value: string): string {
  return value.replace(
    /\b(authorization|token|password|secret|api[-_]?key)\s*[:=]\s*([^\s,;]+)/gi,
    "$1=[redacted]",
  );
}

export function createTimedCall<T>(
  logger: AuditLogger,
  sessionId: string,
  tool: string,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  return fn().then(
    (result) => {
      logger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        tool,
        params,
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    },
    (err) => {
      logger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        tool,
        params,
        durationMs: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    },
  );
}
