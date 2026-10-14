import type { ReactNode } from "react";

import { Icon } from "./icon";

export type SourceStateKind =
  | "empty"
  | "not_configured"
  | "unavailable"
  | "stale"
  | "error"
  | "degraded"
  | "requires_reauthorization"
  | "requires_attention";

export function SourceState({
  state,
  title,
  detail,
  action,
  compact = false,
  checkedAt,
  checkedLabel,
  stale = false,
}: Readonly<{
  state: SourceStateKind;
  title: string;
  detail?: string;
  action?: ReactNode;
  compact?: boolean;
  /** ISO instant reported by the source itself (never the render clock). */
  checkedAt?: string;
  /** Human label for `checkedAt`, already formatted in the user's time zone. */
  checkedLabel?: string;
  stale?: boolean;
}>) {
  return (
    <section
      className={`source-state${compact ? " source-state--compact" : ""}`}
      data-state={state}
      role="status"
    >
      <span className="source-state__icon"><Icon name={state === "stale" || stale ? "refresh" : "system"} /></span>
      <div className="source-state__copy">
        <h2>{title}</h2>
        {detail === undefined ? null : <p>{detail}</p>}
        {checkedAt === undefined ? null : (
          <p className="source-state__checked">Comprobado: <time dateTime={checkedAt}>{checkedLabel ?? checkedAt}</time></p>
        )}
        {stale && state !== "stale" ? <p className="source-state__stale">Datos sin actualizar</p> : null}
      </div>
      {action === undefined ? null : <div className="source-state__action">{action}</div>}
    </section>
  );
}
