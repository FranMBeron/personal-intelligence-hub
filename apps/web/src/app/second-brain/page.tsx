import type { Snapshot } from "@personal-intelligence-hub/contracts";

import { PageHeader } from "../_components/app-shell";
import { CentralEntry } from "../_components/conversation/central-entry";
import { SourceState } from "../_components/source-state";
import { StatusBadge } from "../_components/status-badge";
import { BoardView } from "./_components/board-view";
import { Filters } from "./_components/filters";
import { buildSecondBrainView, type SecondBrainFilters } from "./_lib/view";
import { loadHermesPageData, pageRequestContext, readGateway } from "../../server/page-data";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

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
  const context = await pageRequestContext();
  const [snapshotResult, hermes] = await Promise.all([
    readGateway(serverRuntime.personalData, context, (gateway, current): Promise<Snapshot> => gateway.snapshot(current)),
    loadHermesPageData(context),
  ]);
  const view = snapshotResult.state === "loaded"
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

      <div className="brain-capture page-central">
        <CentralEntry {...hermes.central} />
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
          <p className="collections-hint">Pide a Hermes que cree o reorganice un tablero.</p>
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
