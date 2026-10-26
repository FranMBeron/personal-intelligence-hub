"use client";

import type { CalendarSelection, CalendarSourceStatus } from "@personal-intelligence-hub/contracts";
import { useId, useState } from "react";

import { SourceState } from "../../_components/source-state";
import type { CalendarApi } from "./calendar-client";
import { CalendarProposal } from "./calendar-proposal";
import { CalendarSettings } from "./calendar-settings";
import "./system.css";

const emptySelection: CalendarSelection = { version: 0, items: [] };

/**
 * Page-neutral Sistema slot for Calendar: connection, allowlist and (when the page passes an opaque
 * proposal ID, e.g. from `?proposal=`) a review of that proposal. Selecting a proposal never confirms it.
 */
export function CalendarSection({ initialStatus, initialSelection, proposalId, returnState = null, timeZone, now, client }: Readonly<{
  /** `null` when the status could not be read; nothing is inferred from that failure. */
  initialStatus: CalendarSourceStatus | null;
  initialSelection: CalendarSelection | null;
  proposalId: string | null;
  returnState?: "connected" | "attention" | null;
  timeZone: string;
  now?: string;
  client?: CalendarApi;
}>) {
  const [disconnected, setDisconnected] = useState(false);
  const headingId = useId();
  return (
    <section className="calendar-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Google Calendar</h2>
      {initialStatus === null ? (
        <SourceState compact state="unavailable" title="Google Calendar no disponible" detail="No se pudo leer el estado de la conexión. No se muestran calendarios ni propuestas sin verificar." />
      ) : (
        <>
          <CalendarSettings
            initialStatus={initialStatus}
            initialSelection={initialSelection ?? emptySelection}
            timeZone={timeZone}
            returnState={returnState}
            onDisconnected={() => setDisconnected(true)}
            {...(client === undefined ? {} : { client })}
          />
          {proposalId === null || disconnected ? null : (
            <CalendarProposal key={proposalId} proposalId={proposalId} timeZone={timeZone} {...(now === undefined ? {} : { now })} {...(client === undefined ? {} : { client })} />
          )}
        </>
      )}
    </section>
  );
}
