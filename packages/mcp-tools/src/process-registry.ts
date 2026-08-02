import type { CodexAdapter, ReadResponse } from "@codehands/codex-adapter";

export type ProcessStatus = "running" | "stale" | "exited" | "terminated" | "lost";

export interface ProcessInfo {
  command: string;
  argv?: string[];
  cwd?: string;
  startedAt: string;
  completedAt?: string;
  status: ProcessStatus;
  exitCode?: number;
  sessionId: string;
  generation: number;
  recentOutput?: string;
}

export interface ProcessRegistryOptions {
  maxRetained?: number;
  retentionMs?: number;
  recentOutputChars?: number;
}

const TERMINAL_STATUSES = new Set<ProcessStatus>(["exited", "terminated", "lost"]);

export class ProcessRegistry {
  private readonly entries = new Map<string, ProcessInfo>();
  private readonly maxRetained: number;
  private readonly retentionMs: number;
  private readonly recentOutputChars: number;

  constructor(options: ProcessRegistryOptions = {}) {
    this.maxRetained = options.maxRetained ?? 100;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    this.recentOutputChars = options.recentOutputChars ?? 16_384;
  }

  add(processId: string, info: ProcessInfo): void {
    this.entries.set(processId, info);
    this.cleanup();
  }

  get(processId: string): ProcessInfo | undefined {
    return this.entries.get(processId);
  }

  values(): Array<[string, ProcessInfo]> {
    this.cleanup();
    return Array.from(this.entries.entries());
  }

  size(): number {
    this.cleanup();
    return this.entries.size;
  }

  markGenerationStale(generation: number): void {
    for (const info of this.entries.values()) {
      if (info.status === "running" && info.generation !== generation) info.status = "stale";
    }
  }

  updateFromRead(processId: string, response: ReadResponse, output: string): ProcessInfo | undefined {
    const info = this.entries.get(processId);
    if (!info) return undefined;
    if (output) {
      info.recentOutput = `${info.recentOutput ?? ""}${output}`.slice(-this.recentOutputChars);
    }
    if (response.exited || response.closed) {
      info.status = "exited";
      info.exitCode = response.exitCode;
      info.completedAt ??= new Date().toISOString();
    }
    this.cleanup();
    return info;
  }

  markTerminal(processId: string, status: "terminated" | "lost", exitCode?: number): void {
    const info = this.entries.get(processId);
    if (!info) return;
    info.status = status;
    info.exitCode = exitCode;
    info.completedAt ??= new Date().toISOString();
    this.cleanup();
  }

  async reconcile(
    adapter: CodexAdapter,
    processId: string,
    sessionId: string,
  ): Promise<{ info: ProcessInfo; response?: ReadResponse; found: boolean }> {
    const generation = adapter.getGeneration();
    let info = this.entries.get(processId);
    if (info && TERMINAL_STATUSES.has(info.status)) return { info, found: info.status !== "lost" };
    if (info?.status === "running" && info.generation === generation) return { info, found: true };

    if (!info) {
      info = {
        command: "(unknown process)",
        startedAt: new Date().toISOString(),
        status: "stale",
        sessionId,
        generation,
      };
      this.entries.set(processId, info);
    } else {
      info.status = "stale";
    }

    try {
      const response = await adapter.processRead({ processId, waitMs: 0, maxBytes: 16_384 });
      info.generation = generation;
      info.status = response.exited || response.closed ? "exited" : "running";
      info.exitCode = response.exitCode;
      if (info.status === "exited") info.completedAt ??= new Date().toISOString();
      const output = response.chunks
        .map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8"))
        .join("");
      this.updateFromRead(processId, response, output);
      return { info, response, found: true };
    } catch {
      info.status = "lost";
      info.completedAt = new Date().toISOString();
      this.cleanup();
      return { info, found: false };
    }
  }

  async reconcileAll(adapter: CodexAdapter, sessionId: string): Promise<void> {
    const generation = adapter.getGeneration();
    this.markGenerationStale(generation);
    const candidates = Array.from(this.entries.entries())
      .filter(([, info]) => info.status === "stale")
      .slice(0, 50);
    await Promise.all(candidates.map(([id]) => this.reconcile(adapter, id, sessionId)));
    this.cleanup();
  }

  cleanup(now = Date.now()): void {
    for (const [id, info] of this.entries) {
      if (!TERMINAL_STATUSES.has(info.status)) continue;
      const completed = Date.parse(info.completedAt ?? info.startedAt);
      if (Number.isFinite(completed) && now - completed > this.retentionMs) this.entries.delete(id);
    }

    const terminal = Array.from(this.entries.entries())
      .filter(([, info]) => TERMINAL_STATUSES.has(info.status))
      .sort((a, b) => Date.parse(a[1].completedAt ?? a[1].startedAt) - Date.parse(b[1].completedAt ?? b[1].startedAt));
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - this.maxRetained))) {
      this.entries.delete(id);
    }
  }
}
