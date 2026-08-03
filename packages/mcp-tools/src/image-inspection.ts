export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

function pngInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifInfo(bytes: Buffer): ImageInfo | null {
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return null;
  return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        mimeType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function webpInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return {
      mimeType: "image/webp",
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      mimeType: "image/webp",
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function inspectImage(bytes: Buffer): ImageInfo {
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? gifInfo(bytes) ?? webpInfo(bytes);
  if (!info) throw new Error("Unsupported or invalid image. Supported formats: PNG, JPEG, GIF, and WebP.");
  if (info.width < 1 || info.height < 1) throw new Error("Image dimensions must be positive.");
  if (info.width > 16_384 || info.height > 16_384 || info.width * info.height > 100_000_000) {
    throw new Error("Image dimensions exceed the supported limit of 16384 pixels per side and 100 megapixels.");
  }
  return info;
}
