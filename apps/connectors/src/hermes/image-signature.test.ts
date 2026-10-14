import { describe, expect, it } from "vitest";

import { imageFixtures } from "../../test/hermes/harness.js";
import { detectImageMime } from "./image-signature.js";

describe("detectImageMime", () => {
  it("recognizes PNG, JPEG, and WebP magic bytes", () => {
    expect(detectImageMime(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))).toBe("image/png");
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMime(imageFixtures.webp())).toBe("image/webp");
    expect(detectImageMime(imageFixtures.png())).toBe("image/png");
    expect(detectImageMime(imageFixtures.jpeg())).toBe("image/jpeg");
  });

  it("rejects empty, truncated, SVG, PDF, GIF, and RIFF non-WebP content", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(detectImageMime(new Uint8Array())).toBeNull();
    expect(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageMime(encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).toBeNull();
    expect(detectImageMime(encode("%PDF-1.7\n"))).toBeNull();
    expect(detectImageMime(encode("GIF89a......"))).toBeNull();
    expect(detectImageMime(encode("RIFF\u0004\u0000\u0000\u0000WAVEfmt "))).toBeNull();
    expect(detectImageMime(encode("RIFF\u0004\u0000\u0000\u0000WEB"))).toBeNull();
  });
});
