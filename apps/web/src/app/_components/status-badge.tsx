import type { ReactNode } from "react";

export function StatusBadge({
  children,
  tone = "neutral",
}: Readonly<{
  children: ReactNode;
  tone?: "neutral" | "positive" | "warning" | "danger" | "accent";
}>) {
  return (
    <span className="status-badge" data-tone={tone}>
      <span className="status-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
