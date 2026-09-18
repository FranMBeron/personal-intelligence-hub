"use client";

import {
  ConversationSchema,
  MessageSchema,
  UploadedMediaSchema,
  type HermesCapabilities,
  type MessagePart,
} from "@personal-intelligence-hub/contracts";
import { useEffect, useId, useReducer, useState } from "react";

import { SourceState } from "../source-state";
import { Composer } from "./composer";
import { subscribeToConversationEvents } from "./event-stream";
import {
  conversationReducer,
  initialConversationState,
  type ConversationMessage,
} from "./state";

const problemDetail = async (response: Response): Promise<string> => {
  try {
    const value = (await response.json()) as { detail?: unknown };
    return typeof value.detail === "string"
      ? value.detail
      : "No se pudo completar la operación.";
  } catch {
    return "No se pudo completar la operación.";
  }
};

const postJson = (
  path: string,
  body: unknown,
  headers?: HeadersInit,
): Promise<Response> =>
  fetch(
    new Request(new URL(path, window.location.origin), {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

export function Conversation({
  capabilities,
  agentId,
  unavailableState = "not_configured",
}: Readonly<{
  capabilities: HermesCapabilities | null;
  agentId?: string;
  unavailableState?: "not_configured" | "unavailable";
}>) {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const titleId = useId();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly File[]>([]);
  const [voice, setVoice] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  useEffect(() => {
    if (state.conversationId === null) return;
    const controller = new AbortController();
    void subscribeToConversationEvents({
      conversationId: state.conversationId,
      signal: controller.signal,
      onEvent: (event) => dispatch({ type: "event.received", event }),
      onUnavailable: () =>
        setOperationError(
          "La actualización en tiempo real está intentando reconectar.",
        ),
    });
    return () => controller.abort();
  }, [state.conversationId]);

  if (capabilities === null) {
    return (
      <SourceState
        state={unavailableState}
        title={unavailableState === "not_configured" ? "Hermes no configurado" : "Hermes no disponible"}
        detail={unavailableState === "not_configured"
          ? "Configura el adaptador del servidor para activar la conversación."
          : "La integración está configurada, pero no respondió a esta consulta."}
      />
    );
  }

  const ensureConversation = async (): Promise<string> => {
    if (state.conversationId !== null) return state.conversationId;
    const response = await postJson("/api/ui/v1/conversations", {
      ...(agentId === undefined ? {} : { agentId }),
    });
    if (!response.ok) throw new Error(await problemDetail(response));
    const conversation = ConversationSchema.parse(await response.json());
    dispatch({ type: "conversation.created", conversationId: conversation.id });
    return conversation.id;
  };

  const upload = async (file: File, kind: "attachment" | "voice") => {
    const form = new FormData();
    form.set("kind", kind);
    form.set("media", file);
    const response = await fetch("/api/ui/v1/hermes/uploads", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      body: form,
    });
    if (!response.ok) throw new Error(await problemDetail(response));
    return UploadedMediaSchema.parse(await response.json());
  };

  const sendExisting = async (
    conversationId: string,
    localMessage: ConversationMessage,
    idempotencyKey: string,
  ) => {
    const response = await postJson(
      `/api/ui/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      { parts: localMessage.parts },
      { "idempotency-key": idempotencyKey },
    );
    if (!response.ok) throw new Error(await problemDetail(response));
    const accepted = MessageSchema.parse(await response.json());
    dispatch({
      type: "message.acknowledged",
      localMessageId: localMessage.id,
      message: accepted,
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setOperationError(null);
    const idempotencyKey = crypto.randomUUID();
    const localMessageId = crypto.randomUUID();
    let localMessage: ConversationMessage | undefined;
    try {
      const uploadedAttachments = await Promise.all(
        attachments.map((file) => upload(file, "attachment")),
      );
      const uploadedVoice = voice === null ? null : await upload(voice, "voice");
      const parts: MessagePart[] = [];
      if (text.trim() !== "") parts.push({ kind: "text", text: text.trim() });
      parts.push(
        ...uploadedAttachments.map((media) => ({
          kind: "attachment" as const,
          reference: media.reference,
          name: media.name,
          mimeType: media.mimeType,
          size: media.size,
        })),
      );
      if (uploadedVoice !== null) {
        parts.push({
          kind: "voice",
          reference: uploadedVoice.reference,
          mimeType: uploadedVoice.mimeType,
          size: uploadedVoice.size,
        });
      }
      localMessage = {
        id: localMessageId,
        conversationId: state.conversationId ?? "pending",
        role: "user",
        parts,
        deliveryState: "sending",
        createdAt: new Date().toISOString(),
        idempotencyKey,
      };
      dispatch({ type: "message.submitted", message: localMessage, idempotencyKey });
      setText("");
      setAttachments([]);
      setVoice(null);
      const conversationId = await ensureConversation();
      await sendExisting(conversationId, localMessage, idempotencyKey);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "No se pudo enviar el mensaje.";
      setOperationError(detail);
      if (localMessage !== undefined) {
        dispatch({ type: "message.failed", messageId: localMessage.id, detail });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (message: ConversationMessage) => {
    if (message.idempotencyKey === undefined || state.conversationId === null) return;
    dispatch({ type: "message.retrying", messageId: message.id });
    try {
      await sendExisting(state.conversationId, message, message.idempotencyKey);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "No se pudo reenviar.";
      dispatch({ type: "message.failed", messageId: message.id, detail });
    }
  };

  return (
    <section className="conversation surface" aria-labelledby={titleId}>
      <header className="conversation__header">
        <div><p className="eyebrow">Hermes</p><h2 id={titleId}>Conversa con tu sistema</h2></div>
        <span className="conversation__privacy">No se guarda en el navegador</span>
      </header>
      <div className="conversation__log" role="log" aria-live="polite" aria-relevant="additions text">
        {state.messages.length === 0 ? (
          <p className="conversation__welcome">Hermes puede leer el contexto visible y ejecutar solo lo que le pidas.</p>
        ) : state.messages.map((message) => (
          <article className="message" data-role={message.role} key={message.id}>
            <p className="message__author">{message.role === "user" ? "Tú" : "Hermes"}</p>
            {message.parts.map((part, index) => (
              <p key={`${part.kind}-${index}`}>{part.kind === "text" ? part.text : part.kind === "voice" ? "Nota de voz" : part.name}</p>
            ))}
            <p className="message__state">{message.deliveryState}</p>
            {message.deliveryState === "failed" ? (
              <button className="button button--quiet" type="button" onClick={() => void retry(message)}>Reintentar</button>
            ) : null}
          </article>
        ))}
      </div>
      {operationError === null ? null : <p className="conversation__error" role="status">{operationError}</p>}
      <Composer
        capabilities={capabilities}
        text={text}
        submitting={submitting}
        attachments={attachments}
        voice={voice}
        onTextChange={setText}
        onAttachmentsChange={setAttachments}
        onVoiceChange={setVoice}
        onSubmit={() => void submit()}
      />
    </section>
  );
}
