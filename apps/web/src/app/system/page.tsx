import type { CalendarSelection, CalendarSourceStatus, DeviceConnectionStatus as DeviceStatus, SystemStatus, UserPreferences } from "@personal-intelligence-hub/contracts";

import { PageHeader } from "../_components/app-shell";
import { CentralEntry } from "../_components/conversation/central-entry";
import { DeviceConnectionStatus } from "../_components/device-connection-status";
import { SourceState } from "../_components/source-state";
import { StatusBadge } from "../_components/status-badge";
import { formatInstant } from "../_lib/time-format";
import { CalendarSection } from "./_components/calendar-section";
import { SystemStatusSection } from "./_components/system-status-section";
import { TimeZonePanel } from "./_components/time-zone-panel";
import type { SystemSnapshot } from "./_lib/system-view";
import { deviceConnectionsGateway } from "../../server/device-connections-runtime";
import { installationSettings } from "../../server/installation";
import { loadHermesPageData, pageRequestContext, queryValue, readGateway } from "../../server/page-data";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/** Without a readable user preference, times are shown explicitly in UTC, never in the server's zone. */
const UTC = "Etc/UTC";

const personalDataPresentation = {
  available: { label: "Disponible", tone: "positive" },
  unavailable: { label: "No disponible", tone: "danger" },
  not_configured: { label: "No configurado", tone: "neutral" },
} as const;

export default async function SystemPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const now = new Date();
  const params = await searchParams;
  const proposalId = queryValue(params, "proposal");
  const calendarReturn = queryValue(params, "calendar");
  const returnState = calendarReturn === "connected" || calendarReturn === "attention" ? calendarReturn : null;
  const context = await pageRequestContext();
  const { calendar, preferences, system, personalData } = serverRuntime;
  const deviceConnectionId = installationSettings.deviceConnectionId;
  const deviceGateway = deviceConnectionId === null ? null : deviceConnectionsGateway;

  const [hermes, connectors, calendarStatus, calendarSelection, preference, personalHealth, device] = await Promise.all([
    loadHermesPageData(context),
    readGateway(system, context, (gateway, current): Promise<SystemStatus> => gateway.status(current)),
    // A missing Calendar gateway is "not configured" (the BFF answers 501); a failing one is "unavailable".
    readGateway(calendar, context, (gateway, current): Promise<CalendarSourceStatus> => gateway.status(current)),
    readGateway(calendar, context, (gateway, current): Promise<CalendarSelection> => gateway.selection(current)),
    readGateway(preferences, context, (gateway, current): Promise<UserPreferences> => gateway.get(current)),
    personalData.health(context ?? undefined).catch(() => ({ status: "unavailable" as const, checkedAt: null })),
    readGateway(deviceGateway, context, (gateway, current): Promise<DeviceStatus> => gateway.status(current, deviceConnectionId!)),
  ]);

  const snapshot: SystemSnapshot = { connectors, agents: hermes.agents, calendar: calendarStatus };
  const timeZone = preference.state === "loaded" ? preference.value.timeZone : UTC;
  const health = personalDataPresentation[personalHealth.status];

  return (
    <div className="system-page">
      <PageHeader
        title="Sistema"
        description="Salud, conexiones y preferencias verificables de tu instalación."
      />

      <SystemStatusSection initial={snapshot} now={now.toISOString()} timeZone={timeZone} />

      <div className="system-layout">
        <div className="system-layout__main">
          {calendarStatus.state === "not_configured" ? (
            <section className="calendar-section" aria-labelledby="calendar-not-configured-title">
              <h2 id="calendar-not-configured-title">Google Calendar</h2>
              <SourceState compact state="not_configured" title="Google Calendar no está configurado" detail="Esta instalación no tiene la integración de calendario. No se muestran calendarios ni propuestas." />
            </section>
          ) : (
            <CalendarSection
              initialStatus={calendarStatus.state === "loaded" ? calendarStatus.value : null}
              initialSelection={calendarSelection.state === "loaded" ? calendarSelection.value : null}
              proposalId={proposalId}
              returnState={returnState}
              timeZone={timeZone}
              now={now.toISOString()}
            />
          )}
        </div>

        <div className="system-layout__side">
          <section className="system-panel" aria-labelledby="system-time-zone-title">
            <h2 id="system-time-zone-title">Tu zona horaria</h2>
            {preference.state === "loaded" ? (
              <TimeZonePanel initial={preference.value} />
            ) : preference.state === "not_configured" ? (
              <SourceState compact headingLevel={3} state="not_configured" title="Preferencias no configuradas" detail="Las horas de esta página se muestran en UTC." />
            ) : (
              <SourceState compact headingLevel={3} state="unavailable" title="Preferencias no disponibles" detail="No se pudo leer tu zona horaria; las horas de esta página se muestran en UTC." />
            )}
          </section>

          <section className="system-panel" aria-labelledby="system-device-title">
            <h2 id="system-device-title">Dispositivo</h2>
            {deviceGateway === null || deviceConnectionId === null ? (
              <SourceState compact headingLevel={3} state="not_configured" title="Conexión de dispositivo no configurada" detail="Esta instalación no tiene un dispositivo conectado a PIH." />
            ) : (
              <DeviceConnectionStatus connectionId={deviceConnectionId} initialStatus={device.state === "loaded" ? device.value : null} />
            )}
          </section>

          <section className="system-panel system-personal-data" aria-label="API de datos personales">
            <div className="system-personal-data__header">
              <h2>API de datos personales</h2>
              <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
            </div>
            <p>Tareas, tableros y notas del Second Brain.</p>
            {personalHealth.checkedAt === null ? null : (
              <p className="system-personal-data__checked">
                Comprobada: <time dateTime={personalHealth.checkedAt}>{formatInstant(personalHealth.checkedAt, timeZone)}{preference.state === "loaded" ? "" : " UTC"}</time>
              </p>
            )}
          </section>
        </div>
      </div>

      <div className="page-central">
        <CentralEntry {...hermes.central} />
      </div>
    </div>
  );
}

