import { headers } from "next/headers";

import { PageHeader } from "../_components/app-shell";
import { SourceState } from "../_components/source-state";
import { StatusBadge } from "../_components/status-badge";
import { BoardView } from "./_components/board-view";
import { Filters } from "./_components/filters";
import { buildSecondBrainView, type SecondBrainFilters } from "./_lib/view";
import { deriveRequestContext } from "../../server/context";
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
  const requestContext = deriveRequestContext(await headers());
  let view: ReturnType<typeof buildSecondBrainView> | null = null;
  if (requestContext.ok) {
    try {
      const snapshot = await serverRuntime.personalData.snapshot(requestContext.context);
      view = buildSecondBrainView(snapshot, filters);
    } catch {
      view = null;
    }
  }
  const stale =
    view !== null && Date.now() - new Date(view.generatedAt).getTime() > 5 * 60_000;

  return (
    <div className="second-brain-page">
      <PageHeader
        eyebrow="Conocimiento"
        title="Second Brain"
        description="Explora tableros, tarjetas, etiquetas, relaciones y tareas. Los cambios se solicitan a Hermes."
        aside={view === null ? (
          <StatusBadge tone="danger">No disponible</StatusBadge>
        ) : stale ? (
          <StatusBadge tone="warning">Datos antiguos</StatusBadge>
        ) : (
          <StatusBadge tone="positive">Actualizado</StatusBadge>
        )}
      />

      {view === null ? (
        <SourceState state="unavailable" title="Second Brain no disponible" detail="La API no respondió y no existe una lectura utilizable en esta sesión." />
      ) : (
        <>
          <Filters filters={filters} boards={view.boards} tags={view.tags} />
          {view.totalCards === 0 && view.tasks.length === 0 ? (
            <SourceState state="empty" title="No hay contenido que coincida" detail="Ajusta los filtros o solicita a Hermes que capture nueva información." />
          ) : (
            <BoardView view={view} filters={filters} />
          )}
        </>
      )}
    </div>
  );
}
