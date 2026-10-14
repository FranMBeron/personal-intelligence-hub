export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export const acceptedImageMimeTypes: readonly ImageMimeType[] = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.byteLength >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

/** Identify an accepted image from its magic bytes alone; anything else is `null`. */
export const detectImageMime = (bytes: Uint8Array): ImageMimeType | null => {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
};

export const isAcceptedImageMime = (value: string): value is ImageMimeType =>
  (acceptedImageMimeTypes as readonly string[]).includes(value);
