"use client";

import type { UserPreferences } from "@personal-intelligence-hub/contracts";
import { useRouter } from "next/navigation";

import { TimeZonePreference } from "./time-zone-preference";

/** Page wiring: a saved zone re-renders the server page so every time shown on it uses the new zone. */
export function TimeZonePanel({ initial }: Readonly<{ initial: UserPreferences }>) {
  const router = useRouter();
  return <TimeZonePreference initial={initial} onSaved={() => router.refresh()} />;
}
