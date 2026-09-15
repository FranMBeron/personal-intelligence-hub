import {
  CursorBindingSchema,
  CursorPayloadSchema,
  CursorSchema,
  type CursorBinding,
  type CursorPayload,
} from "@personal-intelligence-hub/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";

import { InvalidCursorError } from "../../application/errors.js";
import type { CursorCodec } from "../../application/ports/cursor-codec.js";

export class HmacCursorCodec implements CursorCodec {
  private readonly key: Buffer;

  constructor(key: string | Uint8Array) {
    this.key = Buffer.from(key);
    if (this.key.byteLength < 32) {
      throw new Error("The cursor signing key must contain at least 32 bytes.");
    }
  }

  encode(input: CursorPayload): string {
    const payload = CursorPayloadSchema.parse(input);
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body).toString("base64url")}`;
  }

  decode(input: string, expected: CursorBinding): CursorPayload {
    try {
      CursorSchema.parse(input);
      const binding = CursorBindingSchema.parse(expected);
      const pieces = input.split(".");
      if (pieces.length !== 2) {
        throw new Error("Malformed signed cursor.");
      }

      const [body, encodedSignature] = pieces;
      if (body === undefined || encodedSignature === undefined) {
        throw new Error("Malformed signed cursor.");
      }

      const suppliedSignature = Buffer.from(encodedSignature, "base64url");
      const expectedSignature = this.sign(body);
      if (
        suppliedSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        throw new Error("Invalid cursor signature.");
      }

      const payload = CursorPayloadSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      );
      if (
        payload.route !== binding.route ||
        payload.filterHash !== binding.filterHash
      ) {
        throw new Error("Cursor binding mismatch.");
      }
      return payload;
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw error;
      }
      throw new InvalidCursorError(error);
    }
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(body).digest();
  }
}
