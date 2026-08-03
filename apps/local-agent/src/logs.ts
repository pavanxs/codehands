import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const POLL_INTERVAL_MS = 250;
const LAST_LINE_SCAN_BYTES = 64 * 1024;
const MAX_VALUE_LENGTH = 320;
const MAX_PARAMS_LENGTH = 1_800;

type UnknownRecord = Record<string, unknown>;

export interface FormattedLiveLog {
  line: string;
  detailLines: string[];
  timestampMs: number | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(value: string, maxLength = MAX_VALUE_LENGTH): string {
  const singleLine = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replaceAll("|", "/")
    .replaceAll("{", "(")
    .replaceAll("}", ")")
    .trim();

  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
}

function flattenValue(value: unknown, key: string, output: string[], depth: number): void {
  if (output.join(" | ").length >= MAX_PARAMS_LENGTH) return;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.push(`${key}=empty list`);
      return;
    }

    const simple = value.every((item) => !isRecord(item) && !Array.isArray(item));
    if (simple) {
      output.push(`${key}=${compactText(value.map(formatScalar).join(", "))}`);
      return;
    }

    value.forEach((item, index) => flattenValue(item, `${key}.${index + 1}`, output, depth + 1));
    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      output.push(`${key}=empty object`);
      return;
    }

    if (depth >= 4) {
      output.push(`${key}=nested details omitted`);
      return;
    }

    for (const [childKey, childValue] of entries) {
      flattenValue(childValue, key ? `${key}.${childKey}` : childKey, output, depth + 1);
    }
    return;
  }

  output.push(`${key}=${formatScalar(value)}`);
}

function formatScalar(value: unknown): string {
  if (value === null) return "none";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return compactText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return compactText(String(value));
}

export function formatParams(params: unknown): string {
  if (!isRecord(params)) return "";

  const output: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    flattenValue(value, key, output, 0);
  }

  const joined = output.join(" | ");
  if (joined.length <= MAX_PARAMS_LENGTH) return joined;
  return `${joined.slice(0, MAX_PARAMS_LENGTH - 1)}…`;
}

function formatDetailParams(value: unknown): string {
  if (!isRecord(value)) return formatScalar(value);
  return formatParams(value);
}

function formatElapsedMs(value: number): string {
  const milliseconds = Math.max(0, value);
  return milliseconds < 1_000 ? `${milliseconds.toFixed(0)}ms` : `${(milliseconds / 1_000).toFixed(3)}s`;
}

function outcomeItems(outcome: unknown): UnknownRecord[] {
  return isRecord(outcome) && Array.isArray(outcome.results)
    ? outcome.results.filter(isRecord)
    : [];
}

function outcomeHasFailure(item: UnknownRecord): boolean {
  if (item.success === false || item.status === "failed" || item.status === "timed_out") return true;
  return Array.isArray(item.children) && item.children.filter(isRecord).some(outcomeHasFailure);
}

function outcomeLabel(item: UnknownRecord): string {
  const children = Array.isArray(item.children) ? item.children.filter(isRecord) : [];
  const failedChildren = children.filter(outcomeHasFailure).length;
  if (item.status === "timed_out" || item.timedOut === true) return "TIMEOUT";
  if (item.success === false || item.status === "failed") return "ERROR";
  if (failedChildren === 0) return "OK";
  return failedChildren === children.length ? "ERROR" : "PARTIAL";
}

function outcomeSuffix(item: UnknownRecord | undefined): string {
  if (!item) return "";
  const parts = [outcomeLabel(item)];
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs)) {
    parts.push(`active ${formatElapsedMs(item.durationMs)}`);
  }
  if (typeof item.exitCode === "number") parts.push(`exit ${item.exitCode}`);
  return parts.join(" | ");
}

function appendOutcome(line: string, item: UnknownRecord | undefined): string {
  const suffix = outcomeSuffix(item);
  return suffix ? `${line} | ${suffix}` : line;
}

function formatBatchCall(call: unknown, index: number, outcome?: UnknownRecord): string[] {
  if (!isRecord(call)) {
    return [`  call ${index} | ${formatScalar(call)}`];
  }

  const tool = typeof call.tool === "string" && call.tool.trim()
    ? compactText(call.tool, 160)
    : "unknown tool";
  const args = isRecord(call.args) ? call.args : {};
  const nestedRequests = Array.isArray(args.requests) ? args.requests : null;

  if (nestedRequests) {
    const controls = { ...args };
    delete controls.requests;
    const controlText = formatParams(controls);

    if (nestedRequests.length === 1) {
      const requestText = formatDetailParams(nestedRequests[0]);
      const childOutcomes = outcome && Array.isArray(outcome.children) ? outcome.children.filter(isRecord) : [];
      const childOutcome = childOutcomes[0];
      const hasDetailedChildOutcome = childOutcome !== undefined
        && ["status", "durationMs", "timedOut", "exitCode"].some((key) => childOutcome[key] !== undefined);
      if (hasDetailedChildOutcome) {
        const header = [`  call ${index}`, tool];
        if (controlText) header.push(controlText);
        return [
          appendOutcome(header.join(" | "), outcome),
          appendOutcome(`    request 1${requestText ? ` | ${requestText}` : ""}`, childOutcome),
        ];
      }
      const details = [controlText, requestText].filter(Boolean).join(" | ");
      return [appendOutcome(`  call ${index} | ${tool}${details ? ` | ${details}` : ""}`, outcome)];
    }

    if (nestedRequests.length > 1) {
      const header = [`  call ${index}`, tool, `requests=${nestedRequests.length}`];
      if (controlText) header.push(controlText);
      return [
        appendOutcome(header.join(" | "), outcome),
        ...nestedRequests.map((request, requestIndex) => {
          const details = formatDetailParams(request);
          const childOutcomes = outcome && Array.isArray(outcome.children) ? outcome.children.filter(isRecord) : [];
          return appendOutcome(`    request ${requestIndex + 1}${details ? ` | ${details}` : ""}`, childOutcomes[requestIndex]);
        }),
      ];
    }
  }

  const details = formatDetailParams(args);
  return [appendOutcome(`  call ${index} | ${tool}${details ? ` | ${details}` : ""}`, outcome)];
}

function formatAggregateParams(tool: string, params: unknown, outcome: unknown): { summary: string; detailLines: string[] } {
  if (!isRecord(params)) return { summary: "", detailLines: [] };
  const results = outcomeItems(outcome);

  if (tool === "batch" && Array.isArray(params.calls)) {
    const controls = { ...params };
    delete controls.calls;
    const summaryParts = [`calls=${params.calls.length}`];
    const controlText = formatParams(controls);
    if (controlText) summaryParts.push(controlText);
    return {
      summary: summaryParts.join(" | "),
      detailLines: params.calls.flatMap((call, index) => formatBatchCall(call, index + 1, results[index])),
    };
  }

  if (Array.isArray(params.requests)) {
    const controls = { ...params };
    delete controls.requests;
    const controlText = formatParams(controls);

    if (params.requests.length === 1) {
      const requestText = formatDetailParams(params.requests[0]);
      return {
        summary: appendOutcome([controlText, requestText].filter(Boolean).join(" | "), results[0]),
        detailLines: [],
      };
    }

    if (params.requests.length > 1) {
      const summaryParts = [`requests=${params.requests.length}`];
      if (controlText) summaryParts.push(controlText);
      return {
        summary: summaryParts.join(" | "),
        detailLines: params.requests.map((request, index) => {
          const details = formatDetailParams(request);
          return appendOutcome(`  request ${index + 1}${details ? ` | ${details}` : ""}`, results[index]);
        }),
      };
    }
  }

  return { summary: formatParams(params), detailLines: [] };
}

export function formatLiveLogLine(
  rawEntry: unknown,
  previousTimestampMs: number | null,
  sequence: number,
): FormattedLiveLog {
  const entry = isRecord(rawEntry) ? rawEntry : {};
  const timestampText = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const parsedTimestamp = timestampText ? Date.parse(timestampText) : Number.NaN;
  const timestampMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
  const clock = timestampMs === null ? "unknown time" : formatClock(timestampMs);

  const durationMs = typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
    ? Math.max(0, entry.durationMs)
    : null;
  const explicitStartedAt = typeof entry.startedAt === "string" ? Date.parse(entry.startedAt) : Number.NaN;
  const startedAtMs = Number.isFinite(explicitStartedAt)
    ? explicitStartedAt
    : timestampMs !== null && durationMs !== null
      ? timestampMs - durationMs
      : null;
  const idleMs = startedAtMs !== null && previousTimestampMs !== null
    ? startedAtMs - previousTimestampMs
    : null;
  const idle = idleMs === null
    ? "idle n/a"
    : idleMs >= 0
      ? `idle ${formatElapsedMs(idleMs)}`
      : `overlap ${formatElapsedMs(-idleMs)}`;

  const results = outcomeItems(entry.outcome);
  const failedResults = results.filter(outcomeHasFailure).length;
  const success = entry.success !== false;
  const status = !success
    ? "ERROR"
    : failedResults === 0
      ? "OK"
      : failedResults === results.length
        ? "ERROR"
        : "PARTIAL";
  const tool = typeof entry.tool === "string" && entry.tool.trim() ? compactText(entry.tool, 160) : "unknown tool";
  const requests = isRecord(entry.params) && Array.isArray(entry.params.requests) ? entry.params.requests : [];
  const isLongPoll = tool === "process_read"
    && requests.some((request) => isRecord(request) && typeof request.waitMs === "number" && request.waitMs > 0);
  const duration = durationMs === null
    ? "duration unknown"
    : isLongPoll
      ? `long-poll ${formatElapsedMs(durationMs)}`
      : tool === "batch"
        ? `elapsed ${formatElapsedMs(durationMs)}`
        : `took ${formatElapsedMs(durationMs)}`;
  const session =
    typeof entry.sessionId === "string" && entry.sessionId.trim()
      ? `session ${compactText(entry.sessionId, 120)}`
      : "session unknown";
  const aggregate = formatAggregateParams(tool, entry.params, entry.outcome);
  const error = typeof entry.error === "string" && entry.error.trim() ? compactText(entry.error, 600) : "";

  const parts = [clock, `call ${sequence}`, idle, status, tool, duration, session];
  if (aggregate.summary) parts.push(aggregate.summary);
  if (error) parts.push(`error=${error}`);

  return { line: parts.join(" | "), detailLines: aggregate.detailLines, timestampMs };
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyLogPath(logDir: string): string {
  return path.join(logDir, `${getUtcDateKey()}.jsonl`);
}

async function statOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";

  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readLastTimestamp(filePath: string, size: number): Promise<number | null> {
  if (size <= 0) return null;

  const start = Math.max(0, size - LAST_LINE_SCAN_BYTES);
  const tail = await readRange(filePath, start, size - start);
  const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || typeof parsed.timestamp !== "string") continue;
      const timestampMs = Date.parse(parsed.timestamp);
      if (Number.isFinite(timestampMs)) return timestampMs;
    } catch {
      // Ignore a partial or malformed final line and continue backwards.
    }
  }

  return null;
}

export async function runLogs(): Promise<void> {
  const logDir = path.join(os.homedir(), ".codehands", "logs");
  let activePath = getDailyLogPath(logDir);
  let initialized = false;
  let offset = 0;
  let remainder = "";
  let previousTimestampMs: number | null = null;
  let sequence = 0;
  let busy = false;

  const initialStat = await statOrNull(activePath);
  if (initialStat) {
    previousTimestampMs = await readLastTimestamp(activePath, initialStat.size);
    offset = initialStat.size;
    initialized = true;
  }

  console.log(`CodeHands live MCP logs | idle=before call | took/elapsed=active time | long-poll=expected wait | source ${logDir} | press Ctrl+C to stop`);

  const poll = async (): Promise<void> => {
    if (busy) return;
    busy = true;

    try {
      const desiredPath = getDailyLogPath(logDir);
      if (desiredPath !== activePath) {
        activePath = desiredPath;
        initialized = false;
        offset = 0;
        remainder = "";
      }

      const currentStat = await statOrNull(activePath);
      if (!currentStat) {
        initialized = false;
        offset = 0;
        remainder = "";
        return;
      }

      if (!initialized) {
        initialized = true;
        offset = 0;
        remainder = "";
      }

      if (currentStat.size < offset) {
        offset = 0;
        remainder = "";
      }

      if (currentStat.size === offset) return;

      const chunk = await readRange(activePath, offset, currentStat.size - offset);
      offset = currentStat.size;

      const lines = `${remainder}${chunk}`.split(/\r?\n/);
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        sequence += 1;

        try {
          const formatted = formatLiveLogLine(JSON.parse(line) as unknown, previousTimestampMs, sequence);
          console.log(formatted.line);
          for (const detailLine of formatted.detailLines) console.log(detailLine);
          if (formatted.timestampMs !== null) previousTimestampMs = formatted.timestampMs;
        } catch {
          console.log(`${formatClock(Date.now())} | call ${sequence} | LOG ERROR | unreadable log entry | raw=${compactText(line, 900)}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${formatClock(Date.now())} | LOG ERROR | ${compactText(message, 900)}`);
    } finally {
      busy = false;
    }
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void poll();
  });
}
