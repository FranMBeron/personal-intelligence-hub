import type { HermesCapabilities, Snapshot } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { PageHeader } from "../_components/app-shell";
import { Conversation } from "../_components/conversation/conversation";
import { SourceState } from "../_components/source-state";
import { StatusBadge } from "../_components/status-badge";
import { BoardView } from "./_components/board-view";
import { Filters } from "./_components/filters";
import { buildSecondBrainView, type SecondBrainFilters } from "./_lib/view";
import { deriveRequestContext } from "../../server/context";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

type Result<T> = { ok: true; value: T } | { ok: false };
const safely = async <T,>(operation: Promise<T>): Promise<Result<T>> => {
  try {
    return { ok: true, value: await operation };
  } catch {
    return { ok: false };
  }
};

type SearchParams = Record<string, string | string[] | undefined>;
const scalar = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const parseFilters = (params: SearchParams): SecondBrainFilters => {
  const q = scalar(params.q);
  const board = scalar(params.board);
  const tag = scalar(params.tag);
  const status = scalar(params.status);
  const cursor = scalar(params.cursor);
  return {
    ...(q === undefined || q === "" ? {} : { q }),
    ...(board === undefined || board === "" ? {} : { board }),
    ...(tag === undefined || tag === "" ? {} : { tag }),
    ...(status === undefined || status === "" ? {} : { status }),
    ...(cursor === undefined || cursor === "" ? {} : { cursor }),
  };
};

export default async function SecondBrainPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const filters = parseFilters(await searchParams);
  const requestContext = deriveRequestContext(await headers());
  const snapshotPromise: Promise<Result<Snapshot>> = requestContext.ok
    ? safely(serverRuntime.personalData.snapshot(requestContext.context))
    : Promise.resolve({ ok: false });
  const capabilitiesPromise: Promise<Result<HermesCapabilities>> =
    requestContext.ok && serverRuntime.hermes !== null
      ? safely(serverRuntime.hermes.capabilities(requestContext.context))
      : Promise.resolve({ ok: false });
  const [snapshotResult, capabilitiesResult] = await Promise.all([
    snapshotPromise,
    capabilitiesPromise,
  ]);
  const view = snapshotResult.ok
    ? buildSecondBrainView(snapshotResult.value, filters)
    : null;
  const stale =
    view !== null && Date.now() - new Date(view.generatedAt).getTime() > 5 * 60_000;

  return (
    <div className="second-brain-page">
      <PageHeader
        title="Second Brain"
        description="Ideas, referencias y conocimiento organizados por Hermes."
        aside={view === null ? (
          <StatusBadge tone="danger">No disponible</StatusBadge>
        ) : stale ? (
          <StatusBadge tone="warning">Datos antiguos</StatusBadge>
        ) : (
          <StatusBadge tone="positive">Actualizado</StatusBadge>
        )}
      />

      <div className="brain-capture">
        <Conversation
          capabilities={capabilitiesResult.ok ? capabilitiesResult.value : null}
          unavailableState={serverRuntime.hermes === null ? "not_configured" : "unavailable"}
        />
      </div>

      <div className="brain-workspace">
        <aside className="brain-collections" aria-label="Tableros">
          <p className="collections-title">Tableros</p>
          {view === null || view.boards.length === 0 ? (
            <p className="collections-empty">Sin tableros disponibles</p>
          ) : (
            view.boards.map((board, index) => (
              <span
                className={`collection-item${filters.board === board.id || (filters.board === undefined && index === 0) ? " collection-item--active" : ""}`}
                key={board.id}
              >
                {board.name}<small>{board.columns.reduce((total, column) => total + column.cards.length, 0)}</small>
              </span>
            ))
          )}
          <p className="collections-hint">Pedile a Hermes que cree o reorganice un tablero.</p>
        </aside>

        <section className="brain-board-area" aria-label="Tablero activo">
          <Filters
            filters={filters}
            boards={view?.boards ?? []}
            tags={view?.tags ?? []}
          />
          {view === null ? (
            <SourceState compact state="unavailable" title="Second Brain no disponible" detail="La API no respondió y no existe una lectura utilizable en esta sesión." />
          ) : view.totalCards === 0 && view.tasks.length === 0 ? (
            <SourceState compact state="empty" title="No hay contenido que coincida" detail="Ajusta los filtros o solicita a Hermes que capture nueva información." />
          ) : (
            <BoardView view={view} filters={filters} />
          )}
        </section>
      </div>
    </div>
  );
}
