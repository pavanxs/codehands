import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { RpcClient } from "./rpc-client.js";
import { METHODS, type InitializeResponse } from "./types.js";

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 1000;

export interface SpawnOptions {
  codexBinary?: string;
  listenMode?: string;
}

export interface ExecServerProcess {
  rpc: RpcClient;
  sessionId: string;
  process: ChildProcess;
}

export class ExecServerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private rpc: RpcClient | null = null;
  private sessionId: string | null = null;
  private restartCount = 0;
  private stopped = false;
  private codexBinary: string;
  private listenMode: string;

  constructor(options: SpawnOptions = {}) {
    super();
    this.codexBinary = options.codexBinary ?? "codex";
    this.listenMode = options.listenMode ?? "stdio";
  }

  async start(): Promise<ExecServerProcess> {
    this.stopped = false;
    this.restartCount = 0;
    return this.spawnAndInit();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cleanup();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getRpc(): RpcClient | null {
    return this.rpc;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private async spawnAndInit(): Promise<ExecServerProcess> {
    return new Promise<ExecServerProcess>((resolve, reject) => {
      let settled = false;

      const isWindows = globalThis.process.platform === "win32";
      let spawnCmd = this.codexBinary;
      let spawnArgs = ["exec-server", "--listen", this.listenMode];
      if (isWindows) {
        const extension = path.win32.extname(this.codexBinary).toLowerCase();
        if (extension !== ".exe" && extension !== ".com") {
          spawnCmd = globalThis.process.env.ComSpec ?? globalThis.process.env.COMSPEC ?? "cmd.exe";
          spawnArgs = [
            "/d",
            "/s",
            "/c",
            "call",
            this.codexBinary,
            "exec-server",
            "--listen",
            this.listenMode,
          ];
        }
      }

      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...globalThis.process.env },
        windowsHide: true,
      });

      this.process = child;

      child.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
          const message = isNotFound
            ? `Codex binary not found: "${this.codexBinary}". Install it with: npm install -g @openai/codex`
            : `Failed to start exec-server: ${err.message}`;
          reject(new Error(message));
          return;
        }
        this.emit("error", err);
        if (!this.stopped) {
          this.handleCrash(null, null);
        }
      });

      if (!child.stdout || !child.stdin) {
        settled = true;
        reject(new Error("Failed to get stdio streams from exec-server process"));
        return;
      }

      const rpc = new RpcClient({
        stdin: child.stdin,
        stdout: child.stdout,
      });
      this.rpc = rpc;

      child.stderr?.on("data", (chunk: Buffer) => {
        this.emit("stderr", chunk.toString("utf-8"));
      });

      child.on("exit", (code: number | null, signal: string | null) => {
        this.emit("exit", code, signal);
        if (!settled) {
          settled = true;
          reject(new Error(`exec-server exited unexpectedly: code=${code}, signal=${signal}`));
          return;
        }
        if (!this.stopped) {
          this.handleCrash(code, signal);
        }
      });

      rpc.on("notification", (method: string, params: unknown) => {
        this.emit("notification", method, params);
      });

      rpc.on("close", () => {
        if (!this.stopped) {
          this.handleCrash(null, null);
        }
      });

      rpc.call<InitializeResponse>(METHODS.initialize, {
        clientName: "codehands",
      }).then((response) => {
        this.sessionId = response.sessionId;
        rpc.notify(METHODS.initialized);
        settled = true;
        this.emit("ready", response.sessionId);
        resolve({ rpc, sessionId: response.sessionId, process: child });
      }).catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  private handleCrash(code: number | null, signal: string | null): void {
    this.cleanup();

    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      this.emit("failed", new Error(
        `exec-server crashed ${MAX_RESTART_ATTEMPTS} times. Last exit: code=${code}, signal=${signal}`,
      ));
      return;
    }

    this.restartCount++;
    this.emit("restarting", this.restartCount, MAX_RESTART_ATTEMPTS);

    setTimeout(() => {
      if (this.stopped) return;
      this.spawnAndInit().catch((err) => {
        this.emit("failed", err);
      });
    }, RESTART_DELAY_MS);
  }

  private cleanup(): void {
    if (this.rpc) {
      this.rpc.destroy();
      this.rpc = null;
    }
    if (this.process && !this.process.killed) {
      this.process.kill();
      this.process = null;
    }
    this.sessionId = null;
  }
}
