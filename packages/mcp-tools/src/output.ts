export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface OutputMetadata {
  truncated: boolean;
  bytesReturned: number;
  charsReturned: number;
  totalBytes?: number;
  totalChars?: number;
}

export function boundedText(
  value: string,
  requestedMaxBytes: number | undefined,
  totalKnown = true,
): { text: string; output: OutputMetadata } {
  const maxBytes = clampOutputBytes(requestedMaxBytes);
  const source = Buffer.from(value, "utf8");
  const truncated = source.byteLength > maxBytes;
  let returned = truncated ? source.subarray(0, maxBytes) : source;

  // Avoid returning a partial UTF-8 sequence at the truncation boundary.
  let text = returned.toString("utf8");
  while (text.endsWith("\uFFFD") && returned.byteLength > 0) {
    returned = returned.subarray(0, returned.byteLength - 1);
    text = returned.toString("utf8");
  }

  return {
    text,
    output: {
      truncated,
      bytesReturned: Buffer.byteLength(text, "utf8"),
      charsReturned: text.length,
      ...(totalKnown
        ? { totalBytes: source.byteLength, totalChars: value.length }
        : {}),
    },
  };
}

export function clampOutputBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.max(1, Math.min(MAX_OUTPUT_BYTES, Math.floor(value)));
}
