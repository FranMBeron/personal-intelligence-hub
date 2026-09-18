"use client";

import { SourceState } from "../_components/source-state";

export default function SystemError({ reset }: { error: Error; reset: () => void }) {
  return (
    <SourceState
      state="error"
      title="No se pudo comprobar el sistema"
      detail="Las fuentes no han cambiado; vuelve a solicitar una comprobación."
      action={<button className="button" type="button" onClick={reset}>Reintentar</button>}
    />
  );
}
