"use client";

import { SourceState } from "./_components/source-state";

export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <SourceState
      state="error"
      title="Esta vista no pudo cargarse"
      detail="El resto del hub sigue disponible. Puedes volver a intentarlo sin perder tu navegación."
      action={<button className="button" onClick={reset}>Reintentar</button>}
    />
  );
}
