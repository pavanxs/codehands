import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

export interface HttpPolicyOptions {
  enabled?: boolean;
  allowedHosts?: string[];
  allowedMethods?: string[];
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
}

export class HttpPolicy {
  private readonly enabled: boolean;
  private readonly allowedHosts: string[];
  private readonly allowedMethods: Set<string>;
  private readonly allowHttp: boolean;
  private readonly allowPrivateNetwork: boolean;

  constructor(options: HttpPolicyOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.allowedHosts = (options.allowedHosts ?? []).map((host) => host.toLowerCase());
    this.allowedMethods = new Set((options.allowedMethods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
    this.allowHttp = options.allowHttp ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  }

  async validate(method: string, rawUrl: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.enabled) {
      return { allowed: false, reason: "HTTP requests are disabled by policy" };
    }

    if (!this.allowedMethods.has(method.toUpperCase())) {
      return { allowed: false, reason: `HTTP method ${method.toUpperCase()} is not allowed by policy` };
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: "HTTP request URL is invalid" };
    }

    if (url.username || url.password) {
      return { allowed: false, reason: "Credentials in request URLs are not allowed" };
    }

    if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
      return { allowed: false, reason: "Only HTTPS URLs are allowed by policy" };
    }

    const hostname = normalizeHostname(url.hostname);
    if (!this.allowedHosts.some((pattern) => hostMatches(hostname, pattern))) {
      return { allowed: false, reason: `Host "${hostname}" is not in http.allowedHosts` };
    }

    if (!this.allowPrivateNetwork) {
      if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateAddress(hostname)) {
        return { allowed: false, reason: `Private or metadata host "${hostname}" is blocked` };
      }

      if (!isIP(hostname)) {
        try {
          const addresses = await lookup(hostname, { all: true, verbatim: true });
          if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
            return { allowed: false, reason: `Host "${hostname}" resolves to a private or unavailable address` };
          }
        } catch (err) {
          return {
            allowed: false,
            reason: `Unable to safely resolve host "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    return { allowed: true };
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalizedPattern = normalizeHostname(pattern);
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === normalizedPattern;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? normalized;
  if (isIP(ipv4) !== 4) return false;

  const octets = ipv4.split(".").map(Number);
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}
