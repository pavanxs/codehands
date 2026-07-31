import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from "./types.js";

export interface RpcClientOptions {
  stdin: Writable;
  stdout: Readable;
}

export class RpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stdin: Writable;
  private closed = false;

  constructor(options: RpcClientOptions) {
    super();
    this.stdin = options.stdin;

    const rl = createInterface({ input: options.stdout });

    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        this.handleMessage(message);
      } catch {
        this.emit("error", new Error(`Failed to parse JSON-RPC message: ${line.slice(0, 100)}`));
      }
    });

    rl.on("close", () => {
      this.closed = true;
      this.rejectAllPending(new Error("exec-server connection closed"));
      this.emit("close");
    });

    options.stdout.on("error", (err: Error) => {
      this.closed = true;
      this.rejectAllPending(err);
      this.emit("error", err);
    });
  }

  async call<TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error("exec-server connection is closed");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && { params }),
    };

    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send(request);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined && { params }),
    };
    this.send(notification);
  }

  isClosed(): boolean {
    return this.closed;
  }

  destroy(): void {
    this.closed = true;
    this.rejectAllPending(new Error("RPC client destroyed"));
    this.removeAllListeners();
  }

  private send(message: JsonRpcRequest | JsonRpcNotification): void {
    const json = JSON.stringify(message);
    this.stdin.write(json + "\n");
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    if ("id" in message && message.id !== undefined) {
      const response = message as JsonRpcResponse;
      const handler = this.pending.get(response.id);
      if (handler) {
        this.pending.delete(response.id);
        if (response.error) {
          handler.reject(
            new RpcError(response.error.code, response.error.message, response.error.data),
          );
        } else {
          handler.resolve(response.result);
        }
      }
    } else {
      const notification = message as JsonRpcNotification;
      this.emit("notification", notification.method, notification.params);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const handler of this.pending.values()) {
      handler.reject(error);
    }
    this.pending.clear();
  }
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`JSON-RPC error ${code}: ${message}`);
    this.name = "RpcError";
  }
}
