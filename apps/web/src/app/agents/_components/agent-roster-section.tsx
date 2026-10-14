"use client";

import type { AgentSummary, Delegation, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";

import { SourceState } from "../../_components/source-state";
import { buildAgentsView, formatAgentTime, type RosterResult } from "../_lib/agents-view";
import type { DelegationReader } from "../_lib/delegation-client";
import { useQueryParam } from "../_lib/use-query-param";
import { DirectConversations, unavailableNote } from "./agent-conversation";
import { AgentRoster } from "./agent-roster";
import { DelegationLedger } from "./delegation-ledger";
import "./agents.css";

/** Focus the profile's card button, or the active filter when the current filter hides that card. */
const restoreFocus = (root: HTMLElement | null, agentId: string): void => {
  if (root === null) return;
  for (const element of root.querySelectorAll<HTMLElement>("[data-agent-open]")) {
    if (element.dataset.agentOpen === agentId) {
      element.focus();
      return;
    }
  }
  root.querySelector<HTMLElement>('.agents-roster__filter[aria-pressed="true"]:not(:disabled)')?.focus();
};

/**
 * Page-neutral Agentes slot: roster, then (when a profile is selected) one
 * full-width workspace with direct chats and the delegation ledger as
 * separate sections, then real reported activity.
 */
export function AgentRosterSection({
  result,
  capabilities,
  renderWorkspace,
  delegationClient,
  sourceThreadHref,
}: Readonly<{
  result: RosterResult;
  capabilities: HermesCapabilities | null;
  /** Direct-conversation slot; defaults to the persistent thread workspace. */
  renderWorkspace?: (agentId: string, agent: AgentSummary) => ReactNode;
  delegationClient?: DelegationReader;
  sourceThreadHref?: (delegation: Delegation) => string;
}>) {
  const view = useMemo(() => buildAgentsView(result), [result]);
  const [selectedId, setSelectedId] = useQueryParam("agent");
  const selected = selectedId === null ? undefined : view.agents.find((agent) => agent.id === selectedId);
  const agentNames = useMemo(
    () => Object.fromEntries(view.agents.map((agent) => [agent.id, agent.displayName])),
    [view.agents],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef<string | undefined>(selected?.id);
  const returnFocusTo = useRef<string | null>(null);
  // Focus only follows user actions; selections restored from the URL (load, back/forward) leave it alone.
  const userInitiated = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const directId = useId();
  const conversationNote = unavailableNote(capabilities);
  const activityId = useId();

  useEffect(() => {
    const current = selected?.id;
    if (current !== previous.current) {
      if (userInitiated.current) {
        if (current !== undefined) headingRef.current?.focus();
        else if (returnFocusTo.current !== null) restoreFocus(rootRef.current, returnFocusTo.current);
      }
      userInitiated.current = false;
      returnFocusTo.current = null;
    }
    previous.current = current;
  }, [selected?.id]);

  const close = (agentId: string) => {
    userInitiated.current = true;
    returnFocusTo.current = agentId;
    setSelectedId(null);
  };

  return (
    <div className="agents-section" ref={rootRef}>
      <AgentRoster result={result} capabilities={capabilities} onProfileToggle={() => { userInitiated.current = true; }} />

      {selected === undefined ? null : (
        <section className="agent-workspace" aria-labelledby={headingId}>
          <header className="agent-workspace__header">
            <h2 className="agent-workspace__title" id={headingId} ref={headingRef} tabIndex={-1}>{selected.displayName}</h2>
            <button
              className="button button--quiet"
              type="button"
              aria-label={`Cerrar espacio de ${selected.displayName}`}
              onClick={() => close(selected.id)}
            >
              Cerrar
            </button>
          </header>
          <div className="agent-workspace__body">
            <section className="agent-workspace__direct" aria-labelledby={directId}>
              <h3 className="agent-workspace__section-title" id={directId}>Conversaciones directas</h3>
              {conversationNote !== null ? (
                <p className="agent-card__conversation-note">{conversationNote}</p>
              ) : renderWorkspace === undefined ? (
                <DirectConversations key={selected.id} agentId={selected.id} agentName={selected.displayName} capabilities={capabilities} />
              ) : renderWorkspace(selected.id, selected)}
            </section>
            <DelegationLedger
              key={selected.id}
              agentId={selected.id}
              agentNames={agentNames}
              headingLevel={3}
              {...(delegationClient === undefined ? {} : { client: delegationClient })}
              {...(sourceThreadHref === undefined ? {} : { sourceThreadHref })}
            />
          </div>
        </section>
      )}

      <section className="agents-activity" aria-labelledby={activityId}>
        <h2 className="agents-activity__title" id={activityId}>Actividad reciente</h2>
        {view.state !== "available" ? (
          <SourceState compact state="unavailable" title="Actividad no disponible" detail="Sin roster no hay estado de actividad que mostrar." />
        ) : view.activity.length === 0 ? (
          <SourceState compact state="empty" title="Sin actividad publicada" detail="La actividad aparecerá cuando Hermes informe trabajo, resultados o alertas reales." />
        ) : (
          <ol className="agents-activity__list">
            {view.activity.map((item) => (
              <li className="agents-activity__item" data-kind={item.kind} key={item.agentId}>
                <strong>{item.displayName}</strong>
                <span>{item.label}</span>
                <time dateTime={item.checkedAt}>{formatAgentTime(item.checkedAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
