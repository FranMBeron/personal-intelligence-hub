"use client";

import {
  type Conversation, type HermesCapabilities, type MessageHistory, type MessagePart,
} from "@personal-intelligence-hub/contracts";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";

import { SourceState } from "../source-state";
import { Composer } from "./composer";
import { subscribeToConversationEvents } from "./event-stream";
import { ConversationClient, ConversationClientError } from "./conversation-client";
import { conversationReducer, initialConversationState, type ConversationMessage } from "./state";
import { UserFacingError } from "./user-facing-error";

const sendErrorMessage = (error: unknown): string => {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof ConversationClientError) {
    if (error.status === 401 || error.status === 403) return "Tu sesión no tiene acceso a esta conversación. Vuelve a iniciar sesión.";
    if (error.status === 404) return "Esta conversación ya no está disponible.";
    if (error.status === 409) return "El envío entró en conflicto con otro cambio. Revisa la conversación antes de reintentar.";
    if (error.status === 413) return "El mensaje o sus adjuntos superan el tamaño permitido.";
    if (error.status === 429) return "Demasiados envíos seguidos. Espera un momento e inténtalo de nuevo.";
    if (error.status >= 500) return "Hermes no pudo procesar el mensaje. Inténtalo de nuevo en unos minutos.";
    return "El mensaje no se pudo validar. Revisa el contenido e inténtalo de nuevo.";
  }
  return "No se pudo enviar el mensaje. Revisa tu conexión e inténtalo de nuevo.";
};

type PendingSend = {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly attachments: readonly File[];
  readonly voice: File | null;
  parts?: MessagePart[];
};

const isSameDraft = (pending: PendingSend, text: string, attachments: readonly File[], voice: File | null): boolean =>
  pending.text === text && pending.voice === voice && pending.attachments.length === attachments.length
  && pending.attachments.every((file, index) => file === attachments[index]);

export function Conversation({
  conversationId = null, agentName = "Hermes", capabilities, onResolveMain, client: suppliedClient, canSend = true,
  unavailableState = "not_configured",
}: Readonly<{
  conversationId?: string | null;
  agentName?: string;
  capabilities: HermesCapabilities | null;
  /**
   * Thread source. Send requires either a selected `conversationId` or `onResolveMain` (which resolves and persists the
   * agent's main thread on first send). Without both, the component renders an explicit "no disponible" state.
   */
  onResolveMain?: () => Promise<Conversation>;
  canSend?: boolean;
  client?: ConversationClient;
  unavailableState?: "not_configured" | "unavailable";
}>) {
  const client = useRef(suppliedClient ?? new ConversationClient()).current;
  const [state, dispatch] = useReducer(conversationReducer, conversationId, (initialId) => ({
    ...initialConversationState,
    conversationId: initialId,
  }));
  const titleId = useId();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly File[]>([]);
  const [voice, setVoice] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const previousDelivery = useRef(new Map<string, string>());
  const generation = useRef(0);
  const activeId = useRef(conversationId);
  const pendingResolvedMain = useRef<string | null>(null);
  const previousId = useRef(conversationId);
  const sendController = useRef<AbortController | null>(null);
  const drafts = useRef(new Map<string, { text: string; attachments: readonly File[]; voice: File | null }>());
  // Sends whose outcome is unknown (interrupted or failed), keyed by thread; resending the same draft reuses the idempotency key and uploads.
  const pendingSends = useRef(new Map<string, PendingSend>());
  const draftKey = conversationId ?? "__main__";

  activeId.current = conversationId;

  const updateDraft = useCallback((next: { text: string; attachments: readonly File[]; voice: File | null }) => {
    drafts.current.set(draftKey, next);
  }, [draftKey]);

  useEffect(() => {
    const previous = previousId.current;
    if (previous === conversationId) return;
    previousId.current = conversationId;
    previousDelivery.current.clear();
    setCompletionAnnouncement("");
    const isResolvedMain = pendingResolvedMain.current === conversationId;
    if (isResolvedMain) {
      pendingResolvedMain.current = null;
    } else {
      sendController.current?.abort();
      generation.current += 1;
      if (conversationId === null) dispatch({ type: "thread.cleared", generation: generation.current });
      else dispatch({ type: "thread.selected", conversationId, generation: generation.current });
    }
    const nextDraft = drafts.current.get(draftKey) ?? { text: "", attachments: [], voice: null };
    setText(nextDraft.text);
    setAttachments(nextDraft.attachments);
    setVoice(nextDraft.voice);
    setOperationError(null);
  }, [conversationId, draftKey]);

  useEffect(() => () => sendController.current?.abort(), []);

  useEffect(() => {
    let completed: ConversationMessage | undefined;
    for (const message of state.messages) {
      const previous = previousDelivery.current.get(message.id);
      if (message.deliveryState === "completed" && previous !== undefined && previous !== "completed") completed = message;
      previousDelivery.current.set(message.id, message.deliveryState);
    }
    if (completed !== undefined) {
      const summary = completed.parts.filter((part) => part.kind === "text").map((part) => part.text).join(" ").slice(0, 240);
      setCompletionAnnouncement(summary === "" ? "Llegó una respuesta completa." : `Respuesta completa: ${summary}`);
    }
  }, [state.messages]);

  useEffect(() => {
    if (conversationId === null || capabilities === null) return;
    const currentGeneration = generation.current;
    const controller = new AbortController();
    const { signal } = controller;
    // Hydrate first, then stream from the snapshot's atomic cursor; a 410 means the cursor expired, so re-snapshot once and resubscribe.
    const run = async () => {
      let rebaseCursor = false;
      let expiriesWithoutProgress = 0;
      while (!signal.aborted) {
        let history: MessageHistory;
        try {
          history = await client.history(conversationId, { limit: 50 }, signal);
        } catch {
          if (!signal.aborted) setOperationError("No se pudo cargar el historial de esta conversación.");
          return;
        }
        if (signal.aborted) return;
        dispatch({ type: "history.loaded", conversationId, generation: currentGeneration, history, rebaseCursor });
        let expired = false;
        await subscribeToConversationEvents({
          conversationId,
          signal,
          initialCursor: history.streamCursor,
          onEvent: (event) => {
            expiriesWithoutProgress = 0;
            dispatch({ type: "event.received", event, conversationId, generation: currentGeneration });
          },
          onCursorExpired: () => { expired = true; },
          onAccessDenied: () => setOperationError("Las actualizaciones en tiempo real se detuvieron porque la sesión no tiene acceso. Vuelve a iniciar sesión."),
          onUnavailable: () => setOperationError("La actualización en tiempo real está intentando reconectar."),
        });
        if (!expired || signal.aborted) return;
        expiriesWithoutProgress += 1;
        if (expiriesWithoutProgress > 1) {
          setOperationError("La actualización en tiempo real se detuvo. Recarga la página para continuar.");
          return;
        }
        rebaseCursor = true;
      }
    };
    void run();
    return () => controller.abort();
  }, [capabilities, client, conversationId]);

  const sendExisting = async (
    targetId: string,
    message: ConversationMessage,
    idempotencyKey: string,
    signal: AbortSignal,
  ) => {
    const accepted = await client.sendMessage(targetId, idempotencyKey, { parts: message.parts }, signal);
    dispatch({ type: "message.acknowledged", localMessageId: message.id, message: accepted });
  };

  const submit = async () => {
    if (submitting || !canSend || capabilities === null || (conversationId === null && onResolveMain === undefined)) return;
    setSubmitting(true);
    setOperationError(null);
    const controller = new AbortController();
    sendController.current?.abort();
    sendController.current = controller;
    let targetGeneration = generation.current;
    let optimistic: ConversationMessage | undefined;
    let targetId = conversationId;
    const isCurrent = () => !controller.signal.aborted && activeId.current === targetId && generation.current === targetGeneration;
    try {
      if (targetId === null) {
        if (onResolveMain === undefined) throw new Error("Selecciona un espacio de conversación antes de enviar.");
        const main = await onResolveMain();
        targetId = main.id;
        const mainDraft = drafts.current.get("__main__");
        if (mainDraft !== undefined) drafts.current.set(main.id, mainDraft);
        if (previousId.current !== main.id) {
          pendingResolvedMain.current = main.id;
          activeId.current = main.id;
          generation.current += 1;
          targetGeneration = generation.current;
          dispatch({ type: "thread.selected", conversationId: main.id, generation: targetGeneration });
        } else {
          targetGeneration = generation.current;
        }
      }
      if (!isCurrent()) return;
      const previous = pendingSends.current.get(targetId);
      const pending: PendingSend = previous !== undefined && isSameDraft(previous, text.trim(), attachments, voice)
        ? previous
        : { idempotencyKey: crypto.randomUUID(), text: text.trim(), attachments, voice };
      pendingSends.current.set(targetId, pending);
      const { idempotencyKey } = pending;
      const localMessageId = crypto.randomUUID();
      let parts = pending.parts;
      if (parts === undefined) {
        const uploadedAttachments = await Promise.all(attachments.map((file) => client.upload(targetId!, file, controller.signal)));
        if (!isCurrent()) return;
        const uploadedVoice = voice === null ? null : await client.upload(targetId!, voice, controller.signal);
        if (!isCurrent()) return;
        const built: MessagePart[] = [];
        if (text.trim() !== "") built.push({ kind: "text", text: text.trim() });
        built.push(...uploadedAttachments.map((media) => ({
          kind: "attachment" as const, reference: media.reference, name: media.name, mimeType: media.mimeType, size: media.size,
        })));
        if (uploadedVoice !== null) built.push({ kind: "voice", reference: uploadedVoice.reference, mimeType: uploadedVoice.mimeType, size: uploadedVoice.size });
        parts = built;
        pending.parts = built;
      }
      optimistic = {
        id: localMessageId, conversationId: targetId, role: "user", parts,
        deliveryState: "sending", createdAt: new Date().toISOString(), idempotencyKey,
      };
      dispatch({ type: "message.submitted", message: optimistic, idempotencyKey });
      if (!isCurrent()) return;
      await sendExisting(targetId, optimistic, idempotencyKey, controller.signal);
      if (pendingSends.current.get(targetId) === pending) pendingSends.current.delete(targetId);
      if (!isCurrent()) return;
      const emptyDraft = { text: "", attachments: [], voice: null };
      drafts.current.set(targetId, emptyDraft);
      if (conversationId === null) drafts.current.set("__main__", emptyDraft);
      setText(""); setAttachments([]); setVoice(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const detail = sendErrorMessage(error);
      setOperationError(detail);
      if (optimistic !== undefined) dispatch({ type: "message.failed", messageId: optimistic.id, detail });
    } finally {
      if (sendController.current === controller) sendController.current = null;
      setSubmitting(false);
    }
  };

  const retry = async (message: ConversationMessage) => {
    if (message.idempotencyKey === undefined || state.conversationId === null) return;
    const controller = new AbortController();
    sendController.current?.abort();
    sendController.current = controller;
    dispatch({ type: "message.retrying", messageId: message.id });
    try { await sendExisting(state.conversationId, message, message.idempotencyKey, controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) {
        const detail = sendErrorMessage(error);
        dispatch({ type: "message.failed", messageId: message.id, detail });
      }
    }
  };

  const changeText = (value: string) => { setText(value); updateDraft({ text: value, attachments, voice }); };
  const changeAttachments = (files: readonly File[]) => { setAttachments(files); updateDraft({ text, attachments: files, voice }); };
  const changeVoice = (file: File | null) => { setVoice(file); updateDraft({ text, attachments, voice: file }); };

  if (capabilities === null) {
    return <section className="conversation conversation--unavailable surface">
      <SourceState compact state={unavailableState} title={unavailableState === "not_configured" ? "Hermes no configurado" : "Hermes no disponible"}
        detail={unavailableState === "not_configured" ? "Configura el adaptador del servidor para activar la conversación." : "La integración está configurada, pero no respondió a esta consulta."} />
    </section>;
  }

  if (conversationId === null && onResolveMain === undefined) {
    return <section className="conversation conversation--unavailable surface">
      <SourceState compact state="unavailable" title="Conversación no disponible en esta vista"
        detail={`Esta vista no tiene un hilo de conversación asignado para ${agentName}. Abre la conversación desde el espacio del agente para escribir.`} />
    </section>;
  }

  return (
    <section className={`conversation surface ${state.messages.length === 0 ? "conversation--empty" : "conversation--active"}`} aria-labelledby={titleId}>
      <header className="conversation__header">
        <div><p className="eyebrow">Hermes</p><h2 id={titleId}>Conversa con {agentName}</h2></div>
        <span className="conversation__privacy">No se guarda en el navegador</span>
      </header>
      <div className="conversation__log" role="log" aria-live="polite" aria-relevant="additions">
        {state.messages.length === 0 ? <p className="conversation__welcome">Hermes puede leer el contexto visible y ejecutar solo lo que le pidas.</p> : state.messages.map((message) => (
          <article className="message" data-role={message.role} key={message.id}>
            <p className="message__author">{message.role === "user" ? "Tú" : "Hermes"}</p>
            {message.parts.map((part, index) => <p key={`${part.kind}-${index}`}>{part.kind === "text" ? part.text : part.kind === "voice" ? "Nota de voz" : part.name}</p>)}
            <p className="message__state">{message.deliveryState}</p>
            {message.deliveryState === "failed" ? <button className="button button--quiet" type="button" onClick={() => void retry(message)}>Reintentar</button> : null}
          </article>
        ))}
      </div>
      {completionAnnouncement === "" ? null : <p className="sr-only" role="status">{completionAnnouncement}</p>}
      {operationError === null ? null : <p className="conversation__error" role="status">{operationError}</p>}
      <Composer agentName={agentName} capabilities={capabilities} text={text} submitting={submitting} attachments={attachments} voice={voice}
        onTextChange={changeText} onAttachmentsChange={changeAttachments} onVoiceChange={changeVoice} onSubmit={() => void submit()} submitDisabled={!canSend} />
    </section>
  );
}
