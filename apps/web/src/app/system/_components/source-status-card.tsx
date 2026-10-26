import { useId } from "react";

import { StatusBadge } from "../../_components/status-badge";
import { formatInstant } from "../../_lib/time-format";
import type { SourceCardView } from "../_lib/system-view";
import "./system.css";

/** One source's own evidence: state, when it was checked, last success, safe reason and capabilities. */
export function SourceStatusCard({ card, timeZone }: Readonly<{ card: SourceCardView; timeZone: string }>) {
  const titleId = useId();
  return (
    <article className="source-status-card" aria-labelledby={titleId} data-state={card.state} data-tone={card.tone}>
      <header className="source-status-card__header">
        <h3 id={titleId}>{card.title}</h3>
        <StatusBadge tone={card.tone}>{card.stateLabel}</StatusBadge>
      </header>
      {card.verified
        ? <p className="source-status-card__verified" data-verified="true"><span aria-hidden="true">✓</span> Verificado en la última comprobación</p>
        : null}
      {card.detail === null ? null : <p className="source-status-card__detail">{card.detail}</p>}
      {card.reason === null ? null : <p className="source-status-card__reason">{card.reason}</p>}
      {card.checkedAt === null ? null : (
        <p className="source-status-card__fact">Comprobado: <time dateTime={card.checkedAt}>{formatInstant(card.checkedAt, timeZone)}</time>{card.ageLabel === null ? null : ` (${card.ageLabel})`}</p>
      )}
      {card.lastSuccessAt === null || card.verified ? null : (
        <p className="source-status-card__fact">Último éxito: <time dateTime={card.lastSuccessAt}>{formatInstant(card.lastSuccessAt, timeZone)}</time></p>
      )}
      {card.stale ? <p className="source-status-card__stale">Datos sin actualizar: se muestra el último valor conocido.</p> : null}
      {card.capabilities.length === 0 ? null : (
        <ul className="source-status-card__capabilities" aria-label={`Capacidades de ${card.title}`}>
          {card.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
        </ul>
      )}
    </article>
  );
}
