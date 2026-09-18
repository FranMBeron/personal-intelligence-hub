import type { ReactNode } from "react";

import { Icon } from "./icon";

export function SourceState({
  state,
  title,
  detail,
  action,
}: Readonly<{
  state: "empty" | "not_configured" | "unavailable" | "stale" | "error";
  title: string;
  detail?: string;
  action?: ReactNode;
}>) {
  return (
    <section className="source-state" data-state={state} role="status">
      <span className="source-state__icon"><Icon name={state === "stale" ? "refresh" : "system"} /></span>
      <div className="source-state__copy">
        <h2>{title}</h2>
        {detail === undefined ? null : <p>{detail}</p>}
      </div>
      {action === undefined ? null : <div className="source-state__action">{action}</div>}
    </section>
  );
}
