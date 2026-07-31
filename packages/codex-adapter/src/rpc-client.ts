import { Readable, Writable } from "node:stream";
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
  private buffer = "";
  private stdin: Writable;
  private closed = false;

  constructor(options: RpcClientOptions) {
    super();
    this.stdin = options.stdin;

    options.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.processBuffer();
    });

    options.stdout.on("end", () => {
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
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    this.stdin.write(header + json);
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (Buffer.byteLength(this.buffer.slice(bodyStart, bodyEnd), "utf-8") < contentLength) {
        break;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const message = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification;
        this.handleMessage(message);
      } catch {
        this.emit("error", new Error(`Failed to parse JSON-RPC message: ${body.slice(0, 100)}`));
      }
    }
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
