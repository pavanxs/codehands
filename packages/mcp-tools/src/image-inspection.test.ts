import { describe, expect, it } from "vitest";
import { inspectImage } from "./image-inspection.js";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("image inspection", () => {
  it("reads PNG dimensions", () => {
    expect(inspectImage(png(320, 200))).toEqual({ mimeType: "image/png", width: 320, height: 200 });
  });

  it("rejects unsupported data", () => {
    expect(() => inspectImage(Buffer.from("not an image"))).toThrow(/Unsupported or invalid image/);
  });

  it("rejects excessive dimensions", () => {
    expect(() => inspectImage(png(16_385, 1))).toThrow(/dimensions exceed/);
  });
});
