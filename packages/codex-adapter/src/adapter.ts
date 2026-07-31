import { EventEmitter } from "node:events";
import { ExecServerManager, type SpawnOptions } from "./spawn.js";
import { RpcClient } from "./rpc-client.js";
import {
  METHODS,
  type ExecParams,
  type ExecResponse,
  type ReadParams,
  type ReadResponse,
  type WriteParams,
  type WriteResponse,
  type SignalParams,
  type SignalResponse,
  type TerminateParams,
  type TerminateResponse,
  type FsReadFileParams,
  type FsReadFileResponse,
  type FsWriteFileParams,
  type FsWriteFileResponse,
  type FsCreateDirectoryParams,
  type FsCreateDirectoryResponse,
  type FsGetMetadataParams,
  type FsGetMetadataResponse,
  type FsReadDirectoryParams,
  type FsReadDirectoryResponse,
  type FsWalkParams,
  type FsRemoveParams,
  type FsRemoveResponse,
  type FsCopyParams,
  type FsCopyResponse,
  type HttpRequestParams,
  type HttpRequestResponse,
  type EnvironmentInfo,
} from "./types.js";

export class CodexAdapter extends EventEmitter {
  private manager: ExecServerManager;
  private ready = false;

  constructor(options: SpawnOptions = {}) {
    super();
    this.manager = new ExecServerManager(options);

    this.manager.on("ready", (sessionId: string) => {
      this.ready = true;
      this.emit("ready", sessionId);
    });

    this.manager.on("restarting", (attempt: number, max: number) => {
      this.ready = false;
      this.emit("restarting", attempt, max);
    });

    this.manager.on("failed", (err: Error) => {
      this.ready = false;
      this.emit("failed", err);
    });

    this.manager.on("notification", (method: string, params: unknown) => {
      this.emit("notification", method, params);
    });

    this.manager.on("stderr", (data: string) => {
      this.emit("stderr", data);
    });
  }

  async start(): Promise<void> {
    await this.manager.start();
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.manager.stop();
  }

  isReady(): boolean {
    return this.ready;
  }

  private rpc(): RpcClient {
    const client = this.manager.getRpc();
    if (!client || client.isClosed()) {
      throw new Error("exec-server is not connected");
    }
    return client;
  }

  // --- Process operations ---

  async processStart(params: Omit<ExecParams, "processId"> & { processId?: string }): Promise<ExecResponse> {
    const processId = params.processId ?? `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.rpc().call<ExecResponse>(METHODS.processStart, {
      ...params,
      processId,
    });
  }

  async processRead(params: ReadParams): Promise<ReadResponse> {
    return this.rpc().call<ReadResponse>(METHODS.processRead, params);
  }

  async processWrite(params: WriteParams): Promise<WriteResponse> {
    return this.rpc().call<WriteResponse>(METHODS.processWrite, params);
  }

  async processSignal(params: SignalParams): Promise<SignalResponse> {
    return this.rpc().call<SignalResponse>(METHODS.processSignal, params);
  }

  async processTerminate(params: TerminateParams): Promise<TerminateResponse> {
    return this.rpc().call<TerminateResponse>(METHODS.processTerminate, params);
  }

  // --- File system operations ---

  async fsReadFile(params: FsReadFileParams): Promise<FsReadFileResponse> {
    return this.rpc().call<FsReadFileResponse>(METHODS.fsReadFile, params);
  }

  async fsWriteFile(params: FsWriteFileParams): Promise<FsWriteFileResponse> {
    return this.rpc().call<FsWriteFileResponse>(METHODS.fsWriteFile, params);
  }

  async fsCreateDirectory(params: FsCreateDirectoryParams): Promise<FsCreateDirectoryResponse> {
    return this.rpc().call<FsCreateDirectoryResponse>(METHODS.fsCreateDirectory, params);
  }

  async fsGetMetadata(params: FsGetMetadataParams): Promise<FsGetMetadataResponse> {
    return this.rpc().call<FsGetMetadataResponse>(METHODS.fsGetMetadata, params);
  }

  async fsReadDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResponse> {
    return this.rpc().call<FsReadDirectoryResponse>(METHODS.fsReadDirectory, params);
  }

  async fsWalk(params: FsWalkParams): Promise<unknown> {
    return this.rpc().call(METHODS.fsWalk, params);
  }

  async fsRemove(params: FsRemoveParams): Promise<FsRemoveResponse> {
    return this.rpc().call<FsRemoveResponse>(METHODS.fsRemove, params);
  }

  async fsCopy(params: FsCopyParams): Promise<FsCopyResponse> {
    return this.rpc().call<FsCopyResponse>(METHODS.fsCopy, params);
  }

  // --- HTTP ---

  async httpRequest(params: HttpRequestParams): Promise<HttpRequestResponse> {
    return this.rpc().call<HttpRequestResponse>(METHODS.httpRequest, params);
  }

  // --- Environment ---

  async getEnvironmentInfo(): Promise<EnvironmentInfo> {
    return this.rpc().call<EnvironmentInfo>(METHODS.environmentInfo);
  }
}
