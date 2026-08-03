import { describe, expect, it } from "vitest";
import type { CodexAdapter, EnvironmentInfo } from "@codehands/codex-adapter";
import { resolveProcessLaunch } from "./process-launch.js";

function fakeAdapter(options: {
  environment?: EnvironmentInfo;
  existing?: RegExp;
} = {}): CodexAdapter {
  return {
    getEnvironmentInfo: async () => options.environment ?? {
      shell: { name: "bash", path: "/bin/bash" },
    },
    fsGetMetadata: async ({ path }: { path: string }) => {
      if (!options.existing?.test(path)) throw new Error("not found");
      return {
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        size: 1,
        createdAtMs: 0,
        modifiedAtMs: 0,
      };
    },
  } as CodexAdapter;
}

describe("resolveProcessLaunch", () => {
  it("uses the shell reported by Codex", async () => {
    const result = await resolveProcessLaunch({
      adapter: fakeAdapter({
        environment: { shell: { name: "zsh", path: "/bin/zsh" } },
      }),
      command: "echo hello",
      shell: true,
      cwd: "/workspace",
      platform: "darwin",
    });

    expect(result.mode).toBe("shell");
    expect(result.argv).toEqual(["/bin/zsh", "-c", "echo hello"]);
    expect(result.policyArgv).toEqual(result.argv);
  });

  it("keeps exact argv for direct execution on POSIX", async () => {
    const result = await resolveProcessLaunch({
      adapter: fakeAdapter(),
      command: "node",
      args: ["-e", "console.log('hello world')"],
      shell: false,
      cwd: "/workspace",
      platform: "linux",
    });

    expect(result.argv).toEqual(["node", "-e", "console.log('hello world')"]);
    expect(result.env).toEqual({});
  });

  it("supports legacy callers by inferring shell mode only when args is omitted", async () => {
    const shellResult = await resolveProcessLaunch({
      adapter: fakeAdapter(),
      command: "echo legacy",
      cwd: "/workspace",
      platform: "linux",
    });
    const directResult = await resolveProcessLaunch({
      adapter: fakeAdapter(),
      command: "node",
      args: [],
      cwd: "/workspace",
      platform: "linux",
    });

    expect(shellResult.mode).toBe("shell");
    expect(directResult.mode).toBe("direct");
  });

  it("rejects args in shell mode", async () => {
    await expect(resolveProcessLaunch({
      adapter: fakeAdapter(),
      command: "echo",
      args: ["hello"],
      shell: true,
      cwd: "/workspace",
      platform: "linux",
    })).rejects.toThrow("args cannot be used when shell is true");
  });

  it("resolves Windows executables before launch", async () => {
    const result = await resolveProcessLaunch({
      adapter: fakeAdapter({ existing: /node\.exe/i }),
      command: "node",
      args: ["--version"],
      shell: false,
      cwd: "C:\\workspace",
      env: {
        PATH: "C:\\tools",
        PATHEXT: ".EXE;.CMD",
      },
      platform: "win32",
    });

    expect(result.argv[0].toLowerCase()).toContain("node.exe");
    expect(result.argv.slice(1)).toEqual(["--version"]);
    expect(result.argv).toEqual(result.policyArgv);
  });

  it("uses a PowerShell argv wrapper for resolved Windows batch shims", async () => {
    const result = await resolveProcessLaunch({
      adapter: fakeAdapter({
        environment: {
          shell: {
            name: "powershell",
            path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          },
        },
        existing: /npm\.cmd/i,
      }),
      command: "npm",
      args: ["run", "check", "A&B"],
      shell: false,
      cwd: "C:\\workspace",
      env: {
        PATH: "C:\\Program Files\\nodejs",
        PATHEXT: ".EXE;.CMD",
      },
      platform: "win32",
    });

    expect(result.argv[0].toLowerCase()).toContain("powershell.exe");
    expect(result.argv).toContain("-EncodedCommand");
    expect(result.policyArgv[0].toLowerCase()).toContain("npm.cmd");
    expect(result.policyArgv.slice(1)).toEqual(["run", "check", "A&B"]);
    expect(result.env).toMatchObject({ PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" });
    const encoded = result.argv.at(-1)!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script.toLowerCase()).toContain("npm.cmd");
    expect(script).toContain("A&B");
  });
});
