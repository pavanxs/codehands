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
    const redacted = { ...entry, params: { ...entry.params } };

    if (redacted.params["content"] !== undefined) {
      const content = redacted.params["content"] as string;
      redacted.params["content"] = `[${content.length} chars]`;
    }

    if (redacted.params["dataBase64"] !== undefined) {
      redacted.params["dataBase64"] = "[redacted]";
    }

    if (redacted.params["body"] !== undefined) {
      redacted.params["body"] = "[redacted]";
    }

    return redacted;
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
