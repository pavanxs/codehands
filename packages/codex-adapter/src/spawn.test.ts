import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecServerManager } from "./spawn.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecServerManager crash recovery", () => {
  it("schedules only one restart for duplicate crash signals", async () => {
    vi.useFakeTimers();
    const manager = new ExecServerManager();
    const cleanup = vi.fn();
    const spawnAndInit = vi.fn().mockResolvedValue({});
    const restarting = vi.fn();
    manager.on("restarting", restarting);
    (manager as any).cleanup = cleanup;
    (manager as any).spawnAndInit = spawnAndInit;

    (manager as any).handleCrash(1, null);
    (manager as any).handleCrash(null, null);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(restarting).toHaveBeenCalledTimes(1);
    expect(restarting).toHaveBeenCalledWith(1, 3);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnAndInit).toHaveBeenCalledTimes(1);
    expect((manager as any).restartScheduled).toBe(false);
  });

  it("cancels a pending restart when stopped", async () => {
    vi.useFakeTimers();
    const manager = new ExecServerManager();
    const spawnAndInit = vi.fn().mockResolvedValue({});
    (manager as any).cleanup = vi.fn();
    (manager as any).spawnAndInit = spawnAndInit;

    (manager as any).handleCrash(1, null);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnAndInit).not.toHaveBeenCalled();
    expect((manager as any).restartScheduled).toBe(false);
  });
});
