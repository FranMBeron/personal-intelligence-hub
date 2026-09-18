import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useId, useRef } from "react";

import { Icon } from "../icon";

export function Composer({ capabilities, text, submitting, attachments, voice, onTextChange, onAttachmentsChange, onVoiceChange, onSubmit }: Readonly<{
  capabilities: HermesCapabilities;
  text: string;
  submitting: boolean;
  attachments: readonly File[];
  voice: File | null;
  onTextChange: (value: string) => void;
  onAttachmentsChange: (files: readonly File[]) => void;
  onVoiceChange: (file: File | null) => void;
  onSubmit: () => void;
}>) {
  const attachmentInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLInputElement>(null);
  const messageId = useId();
  const canSubmit = text.trim() !== "" || attachments.length > 0 || voice !== null;

  return (
    <form className="composer" aria-label="Conversación con Hermes" onSubmit={(event) => {
      event.preventDefault();
      if (canSubmit && !submitting) onSubmit();
    }}>
      <label className="sr-only" htmlFor={messageId}>Mensaje para Hermes</label>
      <textarea id={messageId} name="message" placeholder="Pide un resumen, captura una idea o solicita un cambio…" rows={3} value={text} onChange={(event) => onTextChange(event.target.value)} />
      {attachments.length === 0 && voice === null ? null : (
        <div className="composer__selection" aria-live="polite">
          {attachments.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
          {voice === null ? null : <span>{voice.name}</span>}
        </div>
      )}
      <div className="composer__footer">
        <div className="composer__tools">
          <input className="sr-only" ref={attachmentInput} type="file" multiple tabIndex={-1} accept={capabilities.attachments.enabled ? capabilities.attachments.acceptedMimeTypes.join(",") : undefined} onChange={(event) => onAttachmentsChange(Array.from(event.target.files ?? []).slice(0, capabilities.attachments.enabled ? capabilities.attachments.maxFiles : 0))} />
          <button className="icon-button" type="button" aria-label="Añadir adjunto" disabled={!capabilities.attachments.enabled} aria-describedby={!capabilities.attachments.enabled ? "attachment-unavailable" : undefined} onClick={() => attachmentInput.current?.click()}><Icon name="paperclip" /></button>
          <input className="sr-only" ref={voiceInput} type="file" tabIndex={-1} accept={capabilities.voice.enabled ? capabilities.voice.acceptedMimeTypes.join(",") : undefined} onChange={(event) => onVoiceChange(event.target.files?.[0] ?? null)} />
          <button className="icon-button" type="button" aria-label="Añadir voz" disabled={!capabilities.voice.enabled} aria-describedby={!capabilities.voice.enabled ? "voice-unavailable" : undefined} onClick={() => voiceInput.current?.click()}><Icon name="microphone" /></button>
        </div>
        <button className="button composer__send" type="submit" disabled={!canSubmit || submitting}>{submitting ? "Enviando…" : "Enviar"}<Icon name="send" /></button>
      </div>
      {!capabilities.attachments.enabled ? <p className="capability-note" id="attachment-unavailable">Hermes no admite adjuntos en esta instalación.</p> : null}
      {!capabilities.voice.enabled ? <p className="capability-note" id="voice-unavailable">Hermes no admite voz en esta instalación.</p> : null}
    </form>
  );
}
