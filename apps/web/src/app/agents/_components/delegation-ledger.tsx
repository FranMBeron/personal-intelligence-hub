"use client";

import type { Delegation, DelegationState } from "@personal-intelligence-hub/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { SourceState } from "../../_components/source-state";
import { StatusBadge } from "../../_components/status-badge";
import { DelegationClient, type DelegationReader } from "../_lib/delegation-client";
import { formatAgentTime } from "../_lib/agents-view";
import "./agents.css";

type Tone = "neutral" | "accent" | "positive" | "danger";

const STATES: Readonly<Record<DelegationState, Readonly<{ label: string; tone: Tone }>>> = {
  queued: { label: "En cola", tone: "neutral" },
  running: { label: "En curso", tone: "accent" },
  completed: { label: "Completada", tone: "positive" },
  failed: { label: "Fallida", tone: "danger" },
  cancelled: { label: "Cancelada", tone: "neutral" },
};

/** Text shown for the result; never claims a result the source did not publish. */
const resultText = (delegation: Delegation): string => {
  if (delegation.resultSummary !== undefined) return delegation.resultSummary;
  switch (delegation.state) {
    case "completed": return "Completada sin resumen publicado";
    case "failed": return "Sin resultado: la delegación falló";
    case "cancelled": return "Sin resultado: delegación cancelada";
    default: return "Sin resultado todavía";
  }
};

export const defaultSourceThreadHref = (delegation: Delegation): string =>
  `/?conversation=${encodeURIComponent(delegation.sourceConversationId ?? "")}`;

type Loaded =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; items: readonly Delegation[]; truncated: boolean }>;

const newestFirst = (left: Delegation, right: Delegation): number =>
  Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id);

export function DelegationLedger({
  agentId,
  agentNames = {},
  client: suppliedClient,
  sourceThreadHref = defaultSourceThreadHref,
  limit = 50,
  headingLevel = 2,
}: Readonly<{
  agentId: string;
  agentNames?: Readonly<Record<string, string>>;
  client?: DelegationReader;
  sourceThreadHref?: (delegation: Delegation) => string;
  limit?: number;
  headingLevel?: 2 | 3;
}>) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const fallbackClient = useRef<DelegationReader | null>(null);
  const client = suppliedClient ?? (fallbackClient.current ??= new DelegationClient());
  const titleId = useId();
  const baseId = useId();
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<Readonly<{ key: string; value: Loaded }> | null>(null);
  const [open, setOpen] = useState<Readonly<{ agentId: string; id: string }> | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, Delegation | "failed">>>({});
  const detailRequest = useRef<AbortController | null>(null);
  const loadKey = `${reloadToken}\u0000${agentId}`;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      client.list({ sourceAgentId: agentId, limit }, controller.signal),
      client.list({ targetAgentId: agentId, limit }, controller.signal),
    ]).then(([outgoing, incoming]) => {
      if (controller.signal.aborted) return;
      const byId = new Map<string, Delegation>();
      for (const item of [...outgoing.items, ...incoming.items]) byId.set(item.id, item);
      setLoaded({
        key: loadKey,
        value: {
          status: "ready",
          items: [...byId.values()].toSorted(newestFirst),
          truncated: outgoing.pageInfo.hasNextPage || incoming.pageInfo.hasNextPage,
        },
      });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key: loadKey, value: { status: "error" } });
    });
    return () => controller.abort();
  }, [agentId, client, limit, loadKey]);

  useEffect(() => () => detailRequest.current?.abort(), []);

  const name = (id: string): string => (Object.hasOwn(agentNames, id) ? agentNames[id]! : id);
  const current = loaded?.key === loadKey ? loaded.value : null;
  const openId = open?.agentId === agentId ? open.id : null;

  const toggle = (delegation: Delegation) => {
    detailRequest.current?.abort();
    if (openId === delegation.id) {
      setOpen(null);
      return;
    }
    setOpen({ agentId, id: delegation.id });
    const controller = new AbortController();
    detailRequest.current = controller;
    client.get(delegation.id, controller.signal).then((fresh) => {
      if (controller.signal.aborted || fresh.id !== delegation.id) return;
      setDetails((previous) => ({ ...previous, [delegation.id]: fresh }));
    }).catch(() => {
      if (!controller.signal.aborted) setDetails((previous) => ({ ...previous, [delegation.id]: "failed" }));
    });
  };

  let body;
  if (current === null) {
    body = <p className="delegation-ledger__status" role="status">Cargando delegaciones…</p>;
  } else if (current.status === "error") {
    body = (
      <SourceState
        compact
        state="unavailable"
        title="Delegaciones no disponibles"
        detail="El registro de delegaciones no respondió. No se muestra como vacío."
        action={<button className="button button--quiet" type="button" onClick={() => setReloadToken((value) => value + 1)}>Reintentar</button>}
      />
    );
  } else if (current.items.length === 0) {
    body = <SourceState compact state="empty" title="Sin delegaciones registradas" detail="Este agente no encargó ni recibió trabajo de otros agentes." />;
  } else {
    body = (
      <>
        <ol className="delegation-ledger__list">
          {current.items.map((listed, index) => {
            const fresh = details[listed.id];
            const delegation = fresh === undefined || fresh === "failed" ? listed : fresh;
            const state = STATES[delegation.state];
            const summary = delegation.safeSummary ?? "Sin descripción publicada";
            const detailId = `${baseId}-detail-${index}`;
            const expanded = openId === listed.id;
            return (
              <li className="delegation-ledger__item" key={listed.id}>
                <button
                  className="delegation-ledger__row"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? detailId : undefined}
                  onClick={() => toggle(listed)}
                >
                  <span className="delegation-ledger__route">
                    {name(delegation.sourceAgentId)}
                    <span aria-hidden="true"> → </span>
                    <span className="sr-only"> a </span>
                    {name(delegation.targetAgentId)}
                  </span>
                  <span className="delegation-ledger__summary">{summary}</span>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  <time className="delegation-ledger__time" dateTime={delegation.createdAt}>{formatAgentTime(delegation.createdAt)}</time>
                </button>
                {expanded ? (
                  <div className="delegation-ledger__detail" id={detailId} role="group" aria-label={`Detalle de la delegación: ${summary}`}>
                    <dl className="delegation-ledger__facts">
                      <div><dt>Origen</dt><dd>{name(delegation.sourceAgentId)}</dd></div>
                      <div><dt>Destino</dt><dd>{name(delegation.targetAgentId)}</dd></div>
                      <div><dt>Estado</dt><dd>{state.label}</dd></div>
                      <div><dt>Creada</dt><dd><time dateTime={delegation.createdAt}>{formatAgentTime(delegation.createdAt)}</time></dd></div>
                      <div><dt>Actualizada</dt><dd><time dateTime={delegation.updatedAt}>{formatAgentTime(delegation.updatedAt)}</time></dd></div>
                      {delegation.completedAt === undefined ? null : (
                        <div><dt>Finalizada</dt><dd><time dateTime={delegation.completedAt}>{formatAgentTime(delegation.completedAt)}</time></dd></div>
                      )}
                      <div className="delegation-ledger__wide"><dt>Encargo</dt><dd>{summary}</dd></div>
                      <div className="delegation-ledger__wide"><dt>Resultado</dt><dd>{resultText(delegation)}</dd></div>
                    </dl>
                    {delegation.sourceConversationId === null ? (
                      <p className="delegation-ledger__origin">Origen externo, sin conversación en PIH</p>
                    ) : (
                      <a className="button button--quiet delegation-ledger__origin" href={sourceThreadHref(delegation)}>Abrir conversación de origen</a>
                    )}
                    {fresh === "failed" ? <p className="delegation-ledger__note" role="status">No se pudo actualizar el detalle; se muestra el último estado listado.</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {current.truncated ? <p className="delegation-ledger__note">Se muestran las delegaciones más recientes.</p> : null}
      </>
    );
  }

  return (
    <section className="delegation-ledger" aria-labelledby={titleId}>
      <header className="delegation-ledger__header">
        <Heading id={titleId}>Delegaciones</Heading>
        <p>Encargos entre agentes. Solo lectura: no forman parte de tus conversaciones directas.</p>
      </header>
      {body}
    </section>
  );
}
