import type { ReactNode } from "react";

import { Icon } from "./icon";

export function SourceState({
  state,
  title,
  detail,
  action,
  compact = false,
}: Readonly<{
  state: "empty" | "not_configured" | "unavailable" | "stale" | "error";
  title: string;
  detail?: string;
  action?: ReactNode;
  compact?: boolean;
}>) {
  return (
    <section
      className={`source-state${compact ? " source-state--compact" : ""}`}
      data-state={state}
      role="status"
    >
      <span className="source-state__icon"><Icon name={state === "stale" ? "refresh" : "system"} /></span>
      <div className="source-state__copy">
        <h2>{title}</h2>
        {detail === undefined ? null : <p>{detail}</p>}
      </div>
      {action === undefined ? null : <div className="source-state__action">{action}</div>}
    </section>
  );
}
