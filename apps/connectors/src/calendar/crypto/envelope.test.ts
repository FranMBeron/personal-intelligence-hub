import { describe, expect, it } from "vitest";

import {
  calendarBlindIndex,
  openCalendarValue,
  sealCalendarValue,
  type CalendarKeyring,
} from "./envelope.js";

const keyring = (overrides: Partial<CalendarKeyring> = {}): CalendarKeyring => ({
  activeKeyId: "calendar-key-v1",
  keys: new Map([["calendar-key-v1", new Uint8Array(32).fill(7)]]),
  blindIndexKey: new Uint8Array(32).fill(9),
  ...overrides,
});

const aad = "calendar_connections:actor-1:refresh";

describe("Calendar encrypted envelopes", () => {
  it("round-trips plaintext with the associated data", () => {
    const ring = keyring();
    const envelope = sealCalendarValue("fictional-refresh-token", aad, ring);
    expect(openCalendarValue(envelope, aad, ring)).toBe("fictional-refresh-token");
  });

  it("uses a fresh random nonce for every seal", () => {
    const ring = keyring();
    const first = sealCalendarValue("fictional-refresh-token", aad, ring);
    const second = sealCalendarValue("fictional-refresh-token", aad, ring);
    expect(first).not.toBe(second);
    expect(first.split(".")[2]).not.toBe(second.split(".")[2]);
  });

  it("binds decryption to the associated data", () => {
    const envelope = sealCalendarValue("fictional-refresh-token", aad, keyring());
    expect(() => openCalendarValue(envelope, "calendar_connections:actor-2:refresh", keyring())).toThrow();
  });

  it("rejects ciphertext tampering with a fixed safe error", () => {
    const envelope = sealCalendarValue("fictional-refresh-token", aad, keyring());
    const parts = envelope.split(".");
    const tampered = [...parts];
    tampered[3] = `${parts[3]}A`;
    expect(() => openCalendarValue(tampered.join("."), aad, keyring())).toThrow("calendar_crypto_authentication_failed");
  });

  it("does not include private inputs or key IDs in errors", () => {
    const envelope = sealCalendarValue("fictional-refresh-token", aad, keyring());
    expect(() => openCalendarValue(envelope, "different-aad", keyring())).toThrow("calendar_crypto_authentication_failed");
    try {
      openCalendarValue(envelope, "different-aad", keyring());
    } catch (error) {
      expect((error as Error).message).not.toContain("fictional-refresh-token");
      expect((error as Error).message).not.toContain("calendar-key-v1");
      expect((error as Error).message).not.toContain(envelope);
    }
  });

  it("rejects an unknown key ID without revealing it", () => {
    const envelope = sealCalendarValue("fictional-refresh-token", aad, keyring());
    const parts = envelope.split(".");
    parts[1] = Buffer.from("private-missing-key").toString("base64url");
    expect(() => openCalendarValue(parts.join("."), aad, keyring())).toThrow("calendar_crypto_unknown_key");
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    expect(() => sealCalendarValue("value", aad, keyring({
      keys: new Map([["calendar-key-v1", new Uint8Array(31).fill(7)]]),
    }))).toThrow("calendar_crypto_invalid_keyring");
    expect(() => calendarBlindIndex("value", keyring({ blindIndexKey: new Uint8Array(31).fill(9) }))).toThrow("calendar_crypto_invalid_keyring");
  });

  it("decrypts old values while a rotated key is active", () => {
    const oldRing = keyring();
    const envelope = sealCalendarValue("fictional-refresh-token", aad, oldRing);
    const rotatedRing = keyring({
      activeKeyId: "calendar-key-v2",
      keys: new Map([
        ["calendar-key-v1", new Uint8Array(32).fill(7)],
        ["calendar-key-v2", new Uint8Array(32).fill(8)],
      ]),
    });
    expect(openCalendarValue(envelope, aad, rotatedRing)).toBe("fictional-refresh-token");
    expect(sealCalendarValue("new-value", aad, rotatedRing).split(".")[1]).toBe(Buffer.from("calendar-key-v2").toString("base64url"));
  });

  it("returns stable, keyed blind indexes without embedding the input", () => {
    const ring = keyring();
    const first = calendarBlindIndex("fictional-calendar-id", ring);
    expect(calendarBlindIndex("fictional-calendar-id", ring)).toBe(first);
    expect(calendarBlindIndex("different-calendar-id", ring)).not.toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toContain("fictional-calendar-id");
    expect(calendarBlindIndex("fictional-calendar-id", keyring({ blindIndexKey: new Uint8Array(32).fill(10) }))).not.toBe(first);
  });

  it("rejects malformed envelope versions and decoded field lengths", () => {
    const envelope = sealCalendarValue("fictional-refresh-token", aad, keyring());
    const parts = envelope.split(".");
    expect(() => openCalendarValue(["v2", ...parts.slice(1)].join("."), aad, keyring())).toThrow("calendar_crypto_invalid_envelope");
    expect(() => openCalendarValue([parts[0], parts[1], Buffer.alloc(11).toString("base64url"), parts[3], parts[4]].join("."), aad, keyring())).toThrow("calendar_crypto_invalid_envelope");
    expect(() => openCalendarValue([parts[0], parts[1], parts[2], parts[3], Buffer.alloc(15).toString("base64url")].join("."), aad, keyring())).toThrow("calendar_crypto_invalid_envelope");
  });
});
