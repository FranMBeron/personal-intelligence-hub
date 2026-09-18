"use client";

import { SourceState } from "../_components/source-state";

export default function AgentsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <SourceState
      state="error"
      title="No se pudo cargar Agentes"
      detail="La navegación y las demás fuentes siguen disponibles."
      action={<button className="button" type="button" onClick={reset}>Reintentar</button>}
    />
  );
}
