import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AuditEntry {
  timestamp: string;
  startedAt?: string;
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  error?: string;
  outcome?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  logDir?: string;
  enabled?: boolean;
  redactContent?: boolean;
}

function redactValue(value: unknown, key = ""): unknown {
  if (key === "content" || key === "input" || key === "patch") {
    return typeof value === "string" ? `[${value.length} chars]` : "[redacted]";
  }
  if (key === "dataBase64" || key === "body") return "[redacted]";
  if (key === "env" || key === "headers") {
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (!item || typeof item !== "object") return "[redacted]";
        const name = "name" in item ? String(item.name) : "value";
        return { name, value: "[redacted]" };
      });
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).map((name) => [name, "[redacted]"]));
    }
    return "[redacted]";
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]),
    );
  }
  return value;
}

export class AuditLogger {
  private logDir: string;
  private enabled: boolean;
  private redactContent: boolean;
  private stream: fs.WriteStream | null = null;
  private currentDate: string = "";

  constructor(options: AuditLoggerOptions = {}) {
    this.logDir = options.logDir ?? path.join(os.homedir(), ".codehands", "logs");
    this.enabled = options.enabled ?? true;
    this.redactContent = options.redactContent ?? true;
  }

  log(entry: AuditEntry): void {
    if (!this.enabled) return;

    const sanitized = this.redactContent ? this.redact(entry) : entry;
    const line = JSON.stringify(sanitized) + "\n";

    const stream = this.getStream();
    stream.write(line);
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
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.currentDate = today;
    const logPath = path.join(this.logDir, `${today}.jsonl`);
    this.stream = fs.createWriteStream(logPath, { flags: "a" });
    return this.stream;
  }

  private redact(entry: AuditEntry): AuditEntry {
    return {
      ...entry,
      params: redactValue(entry.params) as Record<string, unknown>,
    };
  }
}

export function createTimedCall<T>(
  logger: AuditLogger,
  sessionId: string,
  tool: string,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  return fn().then(
    (result) => {
      logger.log({
        timestamp: new Date().toISOString(),
        startedAt,
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
        startedAt,
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
