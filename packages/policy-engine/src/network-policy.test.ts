import { describe, expect, it } from "vitest";
import { HttpPolicy, isPrivateAddress } from "./network-policy.js";

describe("HttpPolicy", () => {
  it("is disabled by default", async () => {
    expect((await new HttpPolicy().validate("GET", "https://example.com")).allowed).toBe(false);
  });

  it("requires an allowed HTTPS host and method", async () => {
    const policy = new HttpPolicy({ enabled: true, allowedHosts: ["93.184.216.34"] });
    expect((await policy.validate("GET", "https://93.184.216.34/path")).allowed).toBe(true);
    expect((await policy.validate("POST", "https://93.184.216.34/path")).allowed).toBe(false);
    expect((await policy.validate("GET", "http://93.184.216.34/path")).allowed).toBe(false);
    expect((await policy.validate("GET", "https://not-example.com/path")).allowed).toBe(false);
  });

  it("blocks private and metadata destinations unless explicitly enabled", async () => {
    const policy = new HttpPolicy({
      enabled: true,
      allowedHosts: ["127.0.0.1", "169.254.169.254"],
      allowHttp: true,
    });
    expect((await policy.validate("GET", "http://127.0.0.1:3000")).allowed).toBe(false);
    expect((await policy.validate("GET", "http://169.254.169.254/latest/meta-data")).allowed).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"])(
    "recognizes %s as private",
    (address) => expect(isPrivateAddress(address)).toBe(true),
  );
  it("allows a public address", () => expect(isPrivateAddress("93.184.216.34")).toBe(false));
});
