import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useId, useRef } from "react";

import { Icon } from "../icon";

export function Composer({ agentName, capabilities, text, submitting, attachments, voice, onTextChange, onAttachmentsChange, onVoiceChange, onSubmit, submitDisabled = false }: Readonly<{
  agentName: string;
  capabilities: HermesCapabilities;
  text: string;
  submitting: boolean;
  attachments: readonly File[];
  voice: File | null;
  onTextChange: (value: string) => void;
  onAttachmentsChange: (files: readonly File[]) => void;
  onVoiceChange: (file: File | null) => void;
  onSubmit: () => void;
  submitDisabled?: boolean;
}>) {
  const attachmentInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLInputElement>(null);
  const messageId = useId();
  const canSubmit = text.trim() !== "" || attachments.length > 0 || voice !== null;

  return (
    <form className="composer" aria-label={`Conversación con ${agentName}`} onSubmit={(event) => {
      event.preventDefault();
      if (canSubmit && !submitting && !submitDisabled) onSubmit();
    }}>
      {attachments.length === 0 && voice === null ? null : <div className="composer__selection" aria-live="polite">
        {attachments.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
        {voice === null ? null : <span>{voice.name}</span>}
      </div>}
      <div className="composer__tools">
        <input className="sr-only" ref={attachmentInput} type="file" multiple tabIndex={-1} accept={capabilities.attachments.enabled ? capabilities.attachments.acceptedMimeTypes.join(",") : undefined}
          onChange={(event) => onAttachmentsChange(Array.from(event.target.files ?? []).slice(0, capabilities.attachments.enabled ? capabilities.attachments.maxFiles : 0))} />
        <button className="icon-button" type="button" aria-label="Añadir adjunto" disabled={!capabilities.attachments.enabled} aria-describedby={!capabilities.attachments.enabled ? "attachment-unavailable" : undefined} onClick={() => attachmentInput.current?.click()}><Icon name="paperclip" /></button>
        <input className="sr-only" ref={voiceInput} type="file" tabIndex={-1} onChange={(event) => onVoiceChange(event.target.files?.[0] ?? null)} />
        <button className="icon-button" type="button" aria-label="Añadir voz" disabled={!capabilities.voice.enabled} aria-describedby={!capabilities.voice.enabled ? "voice-unavailable" : undefined} onClick={() => voiceInput.current?.click()}><Icon name="microphone" /></button>
      </div>
      <label className="sr-only" htmlFor={messageId}>Mensaje para {agentName}</label>
      <textarea id={messageId} name="message" placeholder="¿Qué quieres hacer?" rows={1} value={text} onChange={(event) => onTextChange(event.target.value)} />
      <button className="button composer__send" type="submit" disabled={!canSubmit || submitting || submitDisabled}>{submitting ? "Enviando…" : "Enviar"}<Icon name="send" /></button>
      {!capabilities.attachments.enabled ? <p className="capability-note" id="attachment-unavailable">Hermes no admite adjuntos en esta instalación.</p> : null}
      {!capabilities.voice.enabled ? <p className="capability-note" id="voice-unavailable">Hermes no admite voz en esta instalación.</p> : null}
    </form>
  );
}
