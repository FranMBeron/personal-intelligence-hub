"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Conversation as ConversationRecord, type ConversationSelection, type HermesCapabilities, type ConversationList } from "@personal-intelligence-hub/contracts";

import { ConversationClient, ConversationClientError } from "./conversation-client";
import { Conversation } from "./conversation";
import { ThreadSelector } from "./thread-selector";

const pageLimit = 50;
const staleAgentMessage = "Cambiaste de agente antes de terminar; el mensaje no se envió.";
const selectionConflictMessage = "La selección se actualizó en otro lugar. Se cargó el valor más reciente; vuelve a elegir la conversación.";

export function ThreadWorkspace({ agentId, agentName, capabilities, client: suppliedClient }: Readonly<{
  agentId: string;
  agentName: string;
  capabilities: HermesCapabilities | null;
  client?: ConversationClient;
}>) {
  const client = useRef(suppliedClient ?? new ConversationClient()).current;
  const [loadedAgentId, setLoadedAgentId] = useState(agentId);
  const isCurrentAgent = loadedAgentId === agentId;
  const [items, setItems] = useState<readonly ConversationRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ConversationSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<ConversationList["pageInfo"]["nextCursor"]>(null);
  const cursorRef = useRef<ConversationList["pageInfo"]["nextCursor"]>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listGeneration = useRef(0);
  const agentGeneration = useRef(0);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  // Captures the agent session at call time; the returned predicate stays true only while that session is current.
  const captureAgent = useCallback(() => {
    const generation = agentGeneration.current;
    const requested = agentRef.current;
    return () => generation === agentGeneration.current && requested === agentRef.current;
  }, []);

  const readSelection = useCallback((signal?: AbortSignal) => client.getConversationSelection(agentId, signal), [agentId, client]);
  const loadLists = useCallback(async (signal?: AbortSignal, append = false) => {
    const generation = ++listGeneration.current;
    const [active, archived] = await Promise.all([
      client.listConversations({ agentId, archived: false, limit: pageLimit, ...(append && cursorRef.current !== null ? { cursor: cursorRef.current } : {}) }, signal),
      append ? Promise.resolve({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } } as ConversationList) : client.listConversations({ agentId, archived: true, limit: pageLimit }, signal),
    ]);
    if (generation !== listGeneration.current || signal?.aborted) return;
    setItems((previous) => {
      const next = append ? [...previous] : [];
      for (const item of [...active.items, ...archived.items]) {
        if (item.agentId !== agentId) continue;
        const existing = next.findIndex((candidate) => candidate.id === item.id);
        if (existing < 0) next.push(item); else next[existing] = item;
      }
      return next;
    });
    setHasMore(active.pageInfo.hasNextPage);
    setCursor(active.pageInfo.nextCursor);
    cursorRef.current = active.pageInfo.nextCursor;
  }, [agentId, client]);

  const reloadPersistedSelection = useCallback(async (isCurrent: () => boolean) => {
    const current = await readSelection();
    if (!isCurrent() || current.agentId !== agentId) return current;
    setSelection(current);
    setSelectedId(current.conversationId);
    return current;
  }, [agentId, readSelection]);

  useEffect(() => {
    const controller = new AbortController();
    agentGeneration.current += 1;
    setLoadedAgentId(agentId);
    setLoading(true); setError(null); setItems([]); setSelectedId(null); setSelection(null); setCursor(null); cursorRef.current = null; setHasMore(false);
    void Promise.all([loadLists(controller.signal), readSelection(controller.signal)]).then(([, persisted]) => {
      if (controller.signal.aborted) return;
      if (persisted.agentId !== agentId) throw new Error("Selection belongs to another agent.");
      setSelection(persisted); setSelectedId(persisted.conversationId); setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setError("No se pudieron cargar las conversaciones guardadas."); setLoading(false);
    });
    return () => { controller.abort(); listGeneration.current += 1; };
  }, [agentId, loadLists, readSelection]);

  // Applies a selection write only while the agent session that issued it is still current.
  const writeSelection = useCallback(async (isCurrent: () => boolean, conversationId: string, expectedVersion: number) => {
    try {
      const next = await client.selectConversation(agentId, { conversationId, expectedVersion });
      if (!isCurrent()) return null;
      if (next.agentId !== agentId) throw new Error("Selection belongs to another agent.");
      setSelection(next); setSelectedId(next.conversationId); setError(null);
      return next;
    } catch (cause) {
      if (!isCurrent()) return null;
      if (cause instanceof ConversationClientError && cause.status === 409) {
        try { await reloadPersistedSelection(isCurrent); } catch { /* keep the explicit conflict notice below */ }
        if (!isCurrent()) return null;
        setError(selectionConflictMessage);
        throw new Error(selectionConflictMessage);
      }
      throw cause;
    }
  }, [agentId, client, reloadPersistedSelection]);

  const selectThread = useCallback(async (id: string) => {
    if (!isCurrentAgent || selection === null) return;
    await writeSelection(captureAgent(), id, selection.version);
  }, [captureAgent, isCurrentAgent, selection, writeSelection]);

  const persistSelection = useCallback(async (conversation: ConversationRecord, isCurrent: () => boolean) => {
    if (conversation.agentId !== agentId) throw new Error("Conversation belongs to another agent.");
    const current = selection ?? await readSelection();
    if (!isCurrent()) throw new Error(staleAgentMessage);
    const next = await writeSelection(isCurrent, conversation.id, current.version);
    if (next === null) throw new Error(staleAgentMessage);
    setItems((previous) => [conversation, ...previous.filter((item) => item.id !== conversation.id)]);
    return conversation;
  }, [agentId, readSelection, selection, writeSelection]);

  const resolveMainForSend = useCallback(async () => {
    const isCurrent = captureAgent();
    const main = await client.mainConversation(agentId);
    if (!isCurrent()) throw new Error(staleAgentMessage);
    return persistSelection(main, isCurrent);
  }, [agentId, captureAgent, client, persistSelection]);

  const createThread = useCallback(async () => {
    if (!isCurrentAgent || selection === null) return;
    const isCurrent = captureAgent();
    const created = await client.createConversation({ agentId });
    if (!isCurrent()) return;
    if (created.agentId !== agentId) throw new Error("Conversation belongs to another agent.");
    setItems((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
    await writeSelection(isCurrent, created.id, selection.version);
  }, [agentId, captureAgent, client, isCurrentAgent, selection, writeSelection]);

  const mutateThread = useCallback(async (id: string, patch: (item: ConversationRecord) => Promise<ConversationRecord>) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    const updated = await patch(item);
    setItems((previous) => previous.map((candidate) => candidate.id === id ? updated : candidate));
  }, [items]);
  const renameThread = useCallback((id: string, title: string) => mutateThread(id, (item) => client.renameConversation(id, { title, expectedVersion: item.version })), [client, mutateThread]);
  const archiveThread = useCallback((id: string) => mutateThread(id, async (item) => {
    if (selectedId === id) {
      const main = items.find((candidate) => candidate.isMain && !candidate.archived);
      if (main === undefined) throw new Error("Cambia la conversación activa antes de archivarla.");
      await selectThread(main.id);
    }
    return client.archiveConversation(id, { archived: true, expectedVersion: item.version });
  }), [client, items, mutateThread, selectThread, selectedId]);
  const restoreThread = useCallback((id: string) => mutateThread(id, (item) => client.archiveConversation(id, { archived: false, expectedVersion: item.version })), [client, mutateThread]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try { await loadLists(undefined, true); } finally { setLoadingMore(false); }
  }, [cursor, loadLists]);

  const toggleSelector = () => setSelectorOpen((open) => {
    if (open) requestAnimationFrame(() => toggleRef.current?.focus());
    return !open;
  });

  return (
    <section className="thread-workspace" aria-label={`Espacio de conversación de ${agentName}`}>
      <header className="thread-workspace__header">
        <h2>{agentName}</h2>
        <button ref={toggleRef} className="button button--quiet" type="button" onClick={toggleSelector} aria-expanded={selectorOpen}>{selectorOpen ? "Cerrar selector" : "Abrir selector de conversaciones"}</button>
        {!isCurrentAgent || selectedId === null ? null : <p className="thread-workspace__current">Hilo activo</p>}
      </header>
      {!isCurrentAgent || error === null ? null : <p role="status" className="thread-workspace__error">{error}</p>}
      {selectorOpen ? <ThreadSelector items={isCurrentAgent ? items : []} selectedId={isCurrentAgent ? selectedId : null} loading={loading || !isCurrentAgent} onSelect={selectThread} onCreate={createThread} onRename={renameThread} onArchive={archiveThread} onRestore={restoreThread} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} /> : null}
      {isCurrentAgent && selectedId === null && !loading ? <p className="thread-workspace__empty">Escribe un mensaje para abrir la conversación principal de {agentName}.</p> : null}
      {capabilities === null ? <p role="status">La conversación con {agentName} no está disponible ahora.</p> : <Conversation key={agentId} conversationId={isCurrentAgent ? selectedId : null} agentName={agentName} capabilities={capabilities} onResolveMain={resolveMainForSend} canSend={isCurrentAgent && !loading} client={client} />}
    </section>
  );
}
