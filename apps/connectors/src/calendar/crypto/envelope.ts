import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

export type CalendarKeyring = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  blindIndexKey: Uint8Array;
}>;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ERRORS = {
  invalidKeyring: "calendar_crypto_invalid_keyring",
  invalidEnvelope: "calendar_crypto_invalid_envelope",
  unknownKey: "calendar_crypto_unknown_key",
  authenticationFailed: "calendar_crypto_authentication_failed",
} as const;

type SafeErrorCode = (typeof SAFE_ERRORS)[keyof typeof SAFE_ERRORS];

const fail = (code: SafeErrorCode): never => {
  throw new Error(code);
};

const validKey = (key: unknown): key is Uint8Array =>
  key instanceof Uint8Array && key.byteLength === KEY_BYTES;

const validateKeyId = (keyId: unknown): keyId is string =>
  typeof keyId === "string" && KEY_ID_PATTERN.test(keyId);

const getActiveKey = (keyring: CalendarKeyring): Uint8Array => {
  if (
    keyring === null ||
    typeof keyring !== "object" ||
    !validateKeyId(keyring.activeKeyId) ||
    keyring.keys === null ||
    typeof keyring.keys !== "object" ||
    typeof keyring.keys.get !== "function"
  ) {
    return fail(SAFE_ERRORS.invalidKeyring);
  }
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!validKey(key)) return fail(SAFE_ERRORS.invalidKeyring);
  return key;
};

const getBlindIndexKey = (keyring: CalendarKeyring): Uint8Array => {
  if (
    keyring === null ||
    typeof keyring !== "object" ||
    !validKey(keyring.blindIndexKey)
  ) {
    return fail(SAFE_ERRORS.invalidKeyring);
  }
  return keyring.blindIndexKey;
};

const encodeBase64Url = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64url");

const decodeBase64Url = (value: string, allowEmpty = false): Buffer => {
  if ((!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/.test(value)) {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  return decoded;
};

const decodeKeyId = (encoded: string): string => {
  const bytes = decodeBase64Url(encoded);
  let keyId: string;
  try {
    keyId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  if (!validateKeyId(keyId) || encodeBase64Url(Buffer.from(keyId, "utf8")) !== encoded) {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  return keyId;
};

export function sealCalendarValue(
  plaintext: string,
  associatedData: string,
  keyring: CalendarKeyring,
): string {
  const key = getActiveKey(keyring);
  if (typeof plaintext !== "string" || typeof associatedData !== "string") {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      "v1",
      encodeBase64Url(Buffer.from(keyring.activeKeyId, "utf8")),
      encodeBase64Url(nonce),
      encodeBase64Url(ciphertext),
      encodeBase64Url(tag),
    ].join(".");
  } catch {
    return fail(SAFE_ERRORS.authenticationFailed);
  }
}

export function openCalendarValue(
  envelope: string,
  associatedData: string,
  keyring: CalendarKeyring,
): string {
  if (typeof envelope !== "string" || typeof associatedData !== "string") {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }

  const keyId = decodeKeyId(parts[1] ?? "");
  const nonce = decodeBase64Url(parts[2] ?? "");
  const ciphertext = decodeBase64Url(parts[3] ?? "", true);
  const tag = decodeBase64Url(parts[4] ?? "");
  if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
    return fail(SAFE_ERRORS.invalidEnvelope);
  }

  if (
    keyring === null ||
    typeof keyring !== "object" ||
    keyring.keys === null ||
    typeof keyring.keys !== "object" ||
    typeof keyring.keys.get !== "function"
  ) {
    return fail(SAFE_ERRORS.invalidKeyring);
  }
  const key = keyring.keys.get(keyId);
  if (key === undefined) return fail(SAFE_ERRORS.unknownKey);
  if (!validKey(key)) return fail(SAFE_ERRORS.invalidKeyring);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return fail(SAFE_ERRORS.authenticationFailed);
  }
}

export function calendarBlindIndex(
  value: string,
  keyring: CalendarKeyring,
): string {
  const key = getBlindIndexKey(keyring);
  if (typeof value !== "string") return fail(SAFE_ERRORS.invalidKeyring);
  return createHmac("sha256", key)
    .update("calendar-blind-index:v1\0", "utf8")
    .update(value, "utf8")
    .digest("base64url");
}
