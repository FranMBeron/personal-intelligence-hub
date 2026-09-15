import type {
  CursorBinding,
  CursorPayload,
} from "@personal-intelligence-hub/contracts";

export interface CursorCodec {
  encode(input: CursorPayload): string;
  decode(input: string, expected: CursorBinding): CursorPayload;
}
