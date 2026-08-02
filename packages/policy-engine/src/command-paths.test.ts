import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateCommandPaths } from "./command-paths.js";

const workspace = path.resolve("/approved/project");

function validate(args: string[], cwd = workspace) {
  return validateCommandPaths({ command: "tool", args, cwd, workspace });
}

describe("validateCommandPaths", () => {
  it.each([
    ["absolute", [path.resolve("/outside/secret.txt")]],
    ["relative traversal", ["../../outside-secret"]],
    ["embedded traversal", ["src/../../../outside-secret"]],
    ["flag assignment", ["--output=/outside/result.txt"]],
    ["file URL", ["file:///outside/secret.txt"]],
    ["environment-style assignment", ["OUTPUT=/outside/result.txt"]],
    ["home path", ["~/outside-secret"]],
  ])("rejects an outside path in %s form", (_label, args) => {
    expect(validate(args).allowed).toBe(false);
  });

  it("rejects a cwd outside the active workspace", () => {
    expect(validate(["ok"], path.resolve("/outside"))).toMatchObject({ allowed: false });
  });

  it("does not treat an absolute path containing regex symbols as a regex exemption", () => {
    expect(validate(["/outside/(secret)/i"]).allowed).toBe(false);
  });

  it("allows inside paths containing spaces and shell metacharacters as literal argv", () => {
    expect(validate([
      path.join(workspace, "folder (one)", "a b;$(safe)|x.txt"),
      "./folder (one)/a b;$(safe)|x.txt",
      "--output=./build/out (final).txt",
    ])).toEqual({ allowed: true });
  });

  it("does not mistake flags, web URLs, model names, regexes, or plain text for paths", () => {
    expect(validate([
      "--color",
      "never",
      "https://example.test/a/../b",
      "openai/gpt-5.6",
      "foo.+bar",
      "explain ../ literally in this sentence",
    ])).toEqual({ allowed: true });
  });

  it("can exempt a known data argument such as an agent prompt", () => {
    expect(validateCommandPaths({
      command: "codex",
      args: ["exec", "/outside is prompt text"],
      cwd: workspace,
      workspace,
      nonPathArgumentIndexes: [1],
    })).toEqual({ allowed: true });
  });
});
