import { describe, expect, it } from "vitest";
import { CommandPolicy } from "./command-policy.js";

describe("CommandPolicy", () => {
  it("blocks shell interpreters by default", () => {
    const policy = new CommandPolicy();
    expect(policy.validateExecutable("sh").allowed).toBe(false);
    expect(policy.validateExecutable("cmd.exe").allowed).toBe(false);
    expect(policy.validateExecutable("powershell.exe").allowed).toBe(false);
  });

  it("supports an explicit executable allowlist", () => {
    const policy = new CommandPolicy({ allowedExecutables: ["git", "npm"] });
    expect(policy.validateExecutable("/usr/bin/git").allowed).toBe(true);
    expect(policy.validateExecutable("python").allowed).toBe(false);
  });

  it("allows only explicitly configured, non-protected environment variables", () => {
    const policy = new CommandPolicy({ allowedEnvironmentVariables: ["NODE_ENV"] });
    expect(policy.validateEnvironment({ NODE_ENV: "test" }).allowed).toBe(true);
    expect(policy.validateEnvironment({ PATH: "/tmp/evil" }).allowed).toBe(false);
    expect(policy.validateEnvironment({ API_TOKEN: "secret" }).allowed).toBe(false);
  });
});
