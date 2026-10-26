"use client";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";

import { SourceState } from "../source-state";
import type { ConversationClient } from "./conversation-client";
import { ThreadWorkspace } from "./thread-workspace";

/** The installation-configured coordinator profile. Callers resolve it from configuration; no ID is assumed here. */
export type CentralProfile = Readonly<{ id: string; displayName: string }>;
export type CentralSourceState = "available" | "unavailable" | "not_configured";

/**
 * Page-neutral Central conversation slot. Every tab mounts this same entry so the thread shown is always
 * the coordinator's server-backed selection; it never allocates or selects a thread while rendering.
 */
export function CentralEntry({ profile, capabilities, sourceState, client, requestedConversationId = null }: Readonly<{
  profile: CentralProfile | null;
  capabilities: HermesCapabilities | null;
  sourceState: CentralSourceState;
  client?: ConversationClient;
  /** Thread named by a link (e.g. `/?conversation=`); shown read-only until the user makes it active. */
  requestedConversationId?: string | null;
}>) {
  if (profile === null) {
    return (
      <section className="central-entry" aria-label="Conversación central">
        <SourceState compact state="not_configured" title="La conversación central no está configurada" detail="La instalación no define un perfil coordinador. No se abrió ninguna conversación." />
      </section>
    );
  }
  if (sourceState !== "available") {
    return (
      <section className="central-entry" aria-label={`Conversación con ${profile.displayName}`}>
        {sourceState === "not_configured"
          ? <SourceState compact state="not_configured" title={`${profile.displayName} no está configurado`} detail="Configura Hermes para habilitar la conversación central." />
          : <SourceState compact state="unavailable" title={`${profile.displayName} no está disponible`} detail="Hermes no respondió a la última comprobación. Tus conversaciones guardadas no se modificaron." />}
      </section>
    );
  }
  return (
    <div className="central-entry">
      <ThreadWorkspace key={profile.id} agentId={profile.id} agentName={profile.displayName} capabilities={capabilities} requestedConversationId={requestedConversationId} {...(client === undefined ? {} : { client })} />
    </div>
  );
}
