/**
 * Shared character classes for text that reaches a person verbatim.
 *
 * Besides C0/C1 controls, zero-width and bidirectional formatting characters
 * (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+061C) can hide or visually
 * reorder text, so they never belong in a summary or a display name.
 */
const INVISIBLE_FORMATTING = "\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069";

/** Global pattern for stripping from plain-text summaries; tab and newline are kept. */
export const UNSAFE_TEXT_CHARACTERS = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${INVISIBLE_FORMATTING}]`, "gu");

/** Test-only (non-global) pattern for display names: path separators and every unsafe character above. */
export const UNSAFE_NAME_CHARACTERS = new RegExp(`[/\\\\\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE_FORMATTING}]`, "u");
