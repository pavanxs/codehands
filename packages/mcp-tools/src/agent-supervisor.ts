import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { boundedText, clampOutputBytes } from "./output.js";
import { runDirectCommand, startDirectCommand } from "./process-runtime.js";
import type { ToolContext } from "./context.js";

export type AgentStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "lost";

export interface AgentInfo {
  agentId: string;
  task: string;
  repository: string;
  branch: string;
  baseCommit: string;
  worktree: string;
  processId?: string;
  status: AgentStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  model?: string;
  sandbox: "read-only" | "workspace-write";
  recentOutput?: string;
  nextSeq?: number;
  cleaned?: boolean;
  diff?: AgentDiffSummary;
}

interface AgentDiffSummary {
  status: string[];
  stat: string;
  files: string[];
  baseCommit: string;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentInfo>();
  private readonly maxRetained: number;
  private reservations = 0;

  constructor(maxRetained = 50) {
    this.maxRetained = maxRetained;
  }

  set(info: AgentInfo): void {
    this.agents.set(info.agentId, info);
    this.cleanup();
  }

  get(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  tryReserve(maxActive: number): boolean {
    const active = Array.from(this.agents.values()).filter((agent) => ["starting", "running"].includes(agent.status)).length;
    if (active + this.reservations >= maxActive) return false;
    this.reservations++;
    return true;
  }

  releaseReservation(): void {
    this.reservations = Math.max(0, this.reservations - 1);
  }

  private cleanup(): void {
    const completed = Array.from(this.agents.values())
      .filter((agent) => !["starting", "running"].includes(agent.status))
      .sort((a, b) => Date.parse(a.completedAt ?? a.startedAt) - Date.parse(b.completedAt ?? b.startedAt));
    for (const agent of completed.slice(0, Math.max(0, completed.length - this.maxRetained))) {
      this.agents.delete(agent.agentId);
    }
  }
}

const BRANCH_PATTERN = /^(?![-/.])(?!.*\.\.)(?!.*\.$)(?!.*(?:^|\/)\.)(?!.*[~^:?*\[\\\s])[-A-Za-z0-9._/]+$/;
const MAX_PARALLEL_AGENTS = 4;
const WORKER_CONSTRAINTS = [
  "CodeHands worker constraints:",
  "- Do not commit, merge, push, deploy, or delete branches.",
  "- Leave all requested changes in this isolated worktree for the caller to review.",
].join("\n");

function requireAgent(params: Record<string, unknown>, ctx: ToolContext): AgentInfo {
  const agentId = params["agentId"] as string;
  const agent = ctx.agentRegistry.get(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return agent;
}

async function runGit(ctx: ToolContext, repo: string, args: string[], timeoutMs = 30_000) {
  if (!ctx.activeWorkspace) throw new Error("No active workspace. Call workspace_set first.");
  const blocked = ctx.checkBlocked?.("git", args);
  if (blocked) throw new Error(blocked);
  return runDirectCommand({
    adapter: ctx.adapter,
    registry: ctx.processRegistry,
    sessionId: ctx.sessionId,
    command: "git",
    args: ["-C", repo, ...args],
    cwd: repo,
    workspace: ctx.activeWorkspace,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
}

async function resolveRepo(ctx: ToolContext, requested?: string): Promise<string> {
  const cwd = requested ? ctx.resolvePath(requested) : ctx.activeWorkspace;
  if (!cwd) throw new Error("No active workspace. Call workspace_set first or provide repository.");
  const result = await runGit(ctx, cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw new Error(`Not a Git repository: ${result.stderr || cwd}`);
  return ctx.resolvePath(result.stdout.trim());
}

function validateModel(model: string | undefined, allowed: string[]): void {
  if (!model) return;
  if (!allowed.includes(model)) {
    throw new Error("Explicit agent model is not in config.agentModels");
  }
}

export async function agentStart(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const task = (params["task"] as string | undefined)?.trim();
  if (!task) throw new Error("task must not be empty");
  if (task.length > 20_000) throw new Error("task exceeds 20,000 characters");
  if (!ctx.agentRegistry.tryReserve(MAX_PARALLEL_AGENTS)) {
    throw new Error(`At most ${MAX_PARALLEL_AGENTS} agents may be starting or running at once`);
  }
  let reservationHeld = true;
  let repository: string;
  try {
    repository = await resolveRepo(ctx, params["repository"] as string | undefined);
  } catch (error) {
    ctx.agentRegistry.releaseReservation();
    throw error;
  }
  let agentId: string;
  let branch: string;
  let model: string | undefined;
  let sandbox: AgentInfo["sandbox"];
  let baseCommit: string;
  try {
    agentId = `agent-${randomUUID().slice(0, 12)}`;
    const requestedBranch = params["branch"] as string | undefined;
    branch = requestedBranch ?? `codehands/${agentId}`;
    if (!BRANCH_PATTERN.test(branch)) throw new Error(`Invalid branch name: ${branch}`);
    model = params["model"] as string | undefined;
    validateModel(model, ctx.allowedAgentModels);
    sandbox = (params["sandbox"] as AgentInfo["sandbox"] | undefined) ?? "workspace-write";
    if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error(`Unsafe sandbox mode: ${sandbox}`);
    const base = await runGit(ctx, repository, ["rev-parse", "HEAD"]);
    if (base.exitCode !== 0 || !base.stdout.trim()) throw new Error(`Could not resolve repository HEAD: ${base.stderr || base.stdout}`);
    baseCommit = base.stdout.trim();
  } catch (error) {
    ctx.agentRegistry.releaseReservation();
    reservationHeld = false;
    throw error;
  }
  const worktree = ctx.resolvePath(path.join(repository, ".codehands", "worktrees", agentId));
  const info: AgentInfo = {
    agentId,
    task,
    repository,
    branch,
    baseCommit,
    worktree,
    status: "starting",
    startedAt: new Date().toISOString(),
    model,
    sandbox,
  };
  ctx.agentRegistry.set(info);
  ctx.agentRegistry.releaseReservation();
  reservationHeld = false;

  const checkBranch = await runGit(ctx, repository, ["check-ref-format", "--branch", branch]);
  if (checkBranch.exitCode !== 0) {
    info.status = "failed";
    info.completedAt = new Date().toISOString();
    throw new Error(`Invalid branch name: ${branch}`);
  }
  const create = await runGit(ctx, repository, ["worktree", "add", "-b", branch, worktree, "HEAD"], 60_000);
  if (create.exitCode !== 0) {
    info.status = "failed";
    info.completedAt = new Date().toISOString();
    throw new Error(`Could not create agent worktree: ${create.stderr || create.stdout}`);
  }

  try {
    const prompt = `${task}\n\n${WORKER_CONSTRAINTS}`;
    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--sandbox", sandbox,
      "--ephemeral",
      "--color", "never",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
    const blocked = ctx.checkBlocked?.(ctx.codexBinary, args);
    if (blocked) throw new Error(blocked);
    info.processId = await startDirectCommand({
      adapter: ctx.adapter,
      registry: ctx.processRegistry,
      sessionId: ctx.sessionId,
      command: ctx.codexBinary,
      args,
      cwd: worktree,
      workspace: ctx.activeWorkspace!,
      nonPathArgumentIndexes: [args.length - 1],
    });
    info.status = "running";
    return compactAgent(info);
  } catch (error) {
    info.status = "failed";
    info.completedAt = new Date().toISOString();
    await runGit(ctx, repository, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await runGit(ctx, repository, ["branch", "-D", branch]).catch(() => undefined);
    throw error;
  } finally {
    if (reservationHeld) ctx.agentRegistry.releaseReservation();
  }
}

function compactAgent(agent: AgentInfo): unknown {
  return {
    agentId: agent.agentId,
    status: agent.status,
    branch: agent.branch,
    worktree: agent.worktree,
    processId: agent.processId,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    exitCode: agent.exitCode,
  };
}

async function refreshAgent(agent: AgentInfo, ctx: ToolContext, maxBytes = 16_384): Promise<void> {
  if (agent.status !== "running" || !agent.processId) return;
  const boundedMaxBytes = clampOutputBytes(maxBytes);
  const reconciliation = await ctx.processRegistry.reconcile(ctx.adapter, agent.processId, ctx.sessionId);
  if (!reconciliation.found || reconciliation.info.status === "lost") {
    agent.status = "lost";
    agent.completedAt = new Date().toISOString();
    return;
  }
  try {
    const response = reconciliation.response ?? await ctx.adapter.processRead({
      processId: agent.processId,
      afterSeq: agent.nextSeq,
      waitMs: 0,
      maxBytes: boundedMaxBytes,
    });
    const output = response.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8")).join("");
    if (output) agent.recentOutput = `${agent.recentOutput ?? ""}${output}`.slice(-65_536);
    agent.nextSeq = response.nextSeq;
    if (!reconciliation.response) ctx.processRegistry.updateFromRead(agent.processId, response, output);
    if (response.exited || response.closed) {
      agent.exitCode = response.exitCode;
      agent.status = response.exitCode === 0 ? "completed" : "failed";
      agent.completedAt = new Date().toISOString();
    }
  } catch {
    agent.status = "lost";
    agent.completedAt = new Date().toISOString();
  }
}

async function collectAgentDiff(agent: AgentInfo, ctx: ToolContext): Promise<AgentDiffSummary> {
  if (agent.cleaned && agent.diff) return agent.diff;
  const [status, stat, names] = await Promise.all([
    runGit(ctx, agent.worktree, ["status", "--short"]),
    runGit(ctx, agent.worktree, ["diff", "--stat", agent.baseCommit, "--"]),
    runGit(ctx, agent.worktree, ["diff", "--name-status", agent.baseCommit, "--"]),
  ]);
  for (const [label, result] of [["status", status], ["diff stat", stat], ["changed files", names]] as const) {
    if (result.timedOut || result.exitCode !== 0) throw new Error(`Could not read agent ${label}: ${result.stderr || result.stdout}`);
  }
  const diff = {
    status: status.stdout.split("\n").filter(Boolean),
    stat: stat.stdout,
    files: names.stdout.split("\n").filter(Boolean),
    baseCommit: agent.baseCommit,
  };
  agent.diff = diff;
  return diff;
}

export async function agentStatusTool(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const agent = requireAgent(params, ctx);
  await refreshAgent(agent, ctx);
  return compactAgent(agent);
}

export async function agentResults(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const agent = requireAgent(params, ctx);
  const maxOutputBytes = params["maxOutputBytes"] as number | undefined;
  await refreshAgent(agent, ctx, maxOutputBytes);
  const diff = await collectAgentDiff(agent, ctx);
  const bounded = boundedText(agent.recentOutput ?? "", maxOutputBytes);
  return {
    ...compactAgent(agent) as Record<string, unknown>,
    finalOutput: bounded.text,
    output: bounded.output,
    diff,
  };
}

export async function agentCancel(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const agent = requireAgent(params, ctx);
  await refreshAgent(agent, ctx).catch(() => undefined);
  let terminationAttempted = false;
  if (agent.processId && agent.status === "running") {
    terminationAttempted = true;
    try {
      const reconciliation = await ctx.processRegistry.reconcile(ctx.adapter, agent.processId, ctx.sessionId);
      if (reconciliation.found && reconciliation.info.status === "running") {
        await ctx.adapter.processTerminate({ processId: agent.processId });
        ctx.processRegistry.markTerminal(agent.processId, "terminated");
      }
    } catch {
      ctx.processRegistry.markTerminal(agent.processId, "lost");
    }
    agent.status = "cancelled";
    agent.completedAt = new Date().toISOString();
  }
  const cleanup = (params["cleanup"] as boolean | undefined) ?? false;
  let cleaned = agent.cleaned ?? false;
  let cleanupError: string | undefined;
  if (cleanup && !cleaned) {
    try {
      agent.diff = await collectAgentDiff(agent, ctx);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    if (!cleanupError) {
      const removed = await runGit(ctx, agent.repository, ["worktree", "remove", "--force", agent.worktree], 60_000);
      if (removed.exitCode === 0) {
        const branchRemoved = await runGit(ctx, agent.repository, ["branch", "-D", agent.branch]);
        cleaned = branchRemoved.exitCode === 0;
        if (!cleaned) cleanupError = branchRemoved.stderr || branchRemoved.stdout || "Could not delete worker branch";
      } else {
        cleanupError = removed.stderr || removed.stdout || "Could not remove worker worktree";
      }
      agent.cleaned = cleaned;
    }
  }
  return {
    ...compactAgent(agent) as Record<string, unknown>,
    terminationAttempted,
    cleanupRequested: cleanup,
    cleaned,
    ...(cleanupError ? { cleanupError } : {}),
  };
}

export async function agentRunMany(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const tasks = params["tasks"] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array");
  if (tasks.length > MAX_PARALLEL_AGENTS) throw new Error(`agent_run_many is limited to ${MAX_PARALLEL_AGENTS} workers`);
  const results = await Promise.all(tasks.map(async (task, index) => {
    try {
      return { index, success: true, agent: await agentStart(task, ctx) };
    } catch (error) {
      return { index, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { results, total: results.length, started: results.filter((result) => result.success).length };
}
