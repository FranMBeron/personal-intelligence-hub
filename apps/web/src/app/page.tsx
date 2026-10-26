import { CentralEntry } from "./_components/conversation/central-entry";
import { HoyOperationalSection, loadHoyOperational } from "./_components/hoy-operational-section";
import { loadHermesPageData, pageRequestContext, queryValue } from "../server/page-data";
import { serverRuntime } from "../server/runtime";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const unavailable = (): Promise<never> => Promise.reject(new Error("Delegated request context unavailable."));

export default async function HomePage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  // One server-captured instant drives the local day, the greeting and the agenda window.
  const now = new Date();
  const requestedConversationId = queryValue(await searchParams, "conversation");
  const context = await pageRequestContext();
  const { personalData, preferences, calendar } = serverRuntime;
  const [operational, hermes] = await Promise.all([
    loadHoyOperational({
      preferences: preferences === null ? null : () => (context === null ? unavailable() : preferences.get(context)),
      snapshot: () => (context === null ? unavailable() : personalData.snapshot(context)),
      calendarStatus: calendar === null ? null : () => (context === null ? unavailable() : calendar.status(context)),
      // Agenda failures pass through unchanged so their safe problem code survives.
      agenda: calendar === null ? null : (query) => (context === null ? unavailable() : calendar.agenda(context, query)),
    }, now),
    loadHermesPageData(context),
  ]);

  return (
    <div className="hoy-page">
      <h1 className="sr-only">Hoy</h1>
      <HoyOperationalSection
        priorities={operational.priorities}
        agenda={operational.agenda}
        timeZone={operational.timeZone}
        now={now.toISOString()}
      />
      <div className="page-central">
        <CentralEntry {...hermes.central} requestedConversationId={requestedConversationId} />
      </div>
    </div>
  );
}
