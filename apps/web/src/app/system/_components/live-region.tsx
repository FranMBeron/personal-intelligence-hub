import type { ReactNode } from "react";

import "./system.css";

/**
 * A live region that stays mounted, empty while there is nothing to say, so assistive technology announces
 * content that appears later. Mounting a region together with its text is often not announced at all.
 */
export function LiveRegion({ kind, children }: Readonly<{ kind: "status" | "alert"; children?: ReactNode }>) {
  return <div className="live-region" role={kind}>{children}</div>;
}
