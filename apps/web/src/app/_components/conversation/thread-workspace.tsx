"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Conversation as ConversationRecord, type ConversationSelection, type HermesCapabilities, type ConversationList } from "@personal-intelligence-hub/contracts";

import { ConversationClient, ConversationClientError } from "./conversation-client";
import { Conversation } from "./conversation";
import { ThreadSelector } from "./thread-selector";

const pageLimit = 50;
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
        const existing = next.findIndex((candidate) => candidate.id === item.id);
        if (existing < 0) next.push(item); else next[existing] = item;
      }
      return next;
    });
    setHasMore(active.pageInfo.hasNextPage);
    setCursor(active.pageInfo.nextCursor);
    cursorRef.current = active.pageInfo.nextCursor;
  }, [agentId, client]);

  const reloadPersistedSelection = useCallback(async () => {
    const current = await readSelection();
    setSelection(current);
    setSelectedId(current.conversationId);
    return current;
  }, [readSelection]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadedAgentId(agentId);
    setLoading(true); setError(null); setItems([]); setSelectedId(null); setSelection(null); setCursor(null); cursorRef.current = null; setHasMore(false);
    void Promise.all([loadLists(controller.signal), readSelection(controller.signal)]).then(([, persisted]) => {
      if (controller.signal.aborted) return;
      setSelection(persisted); setSelectedId(persisted.conversationId); setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setError("No se pudieron cargar las conversaciones guardadas."); setLoading(false);
    });
    return () => { controller.abort(); listGeneration.current += 1; };
  }, [agentId, loadLists, readSelection]);

  const selectThread = useCallback(async (id: string) => {
    if (!isCurrentAgent || selection === null) return;
    try {
      const next = await client.selectConversation(agentId, { conversationId: id, expectedVersion: selection.version });
      setSelection(next); setSelectedId(next.conversationId); setError(null);
    } catch (cause) {
      if (cause instanceof ConversationClientError && cause.status === 409) {
        try { await reloadPersistedSelection(); } catch { /* keep the explicit conflict notice below */ }
        setError(selectionConflictMessage);
        throw new Error(selectionConflictMessage);
      }
      throw cause;
    }
  }, [agentId, client, isCurrentAgent, reloadPersistedSelection, selection]);

  const persistSelection = useCallback(async (conversation: ConversationRecord) => {
    const current = selection ?? await readSelection();
    try {
      const next = await client.selectConversation(agentId, { conversationId: conversation.id, expectedVersion: current.version });
      setSelection(next); setSelectedId(next.conversationId);
      setItems((previous) => [conversation, ...previous.filter((item) => item.id !== conversation.id)]);
      return conversation;
    } catch (cause) {
      if (cause instanceof ConversationClientError && cause.status === 409) {
        try { await reloadPersistedSelection(); } catch { /* keep the explicit conflict notice below */ }
        setError(selectionConflictMessage);
        throw new Error(selectionConflictMessage);
      }
      throw cause;
    }
  }, [agentId, client, readSelection, reloadPersistedSelection, selection]);

  const resolveMainForSend = useCallback(async () => persistSelection(await client.mainConversation(agentId)), [agentId, client, persistSelection]);

  const createThread = useCallback(async () => {
    if (!isCurrentAgent || selection === null) return;
    const created = await client.createConversation({ agentId });
    setItems((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
    try {
      const next = await client.selectConversation(agentId, { conversationId: created.id, expectedVersion: selection?.version ?? 0 });
      setSelection(next); setSelectedId(next.conversationId); setError(null);
    } catch (cause) {
      if (cause instanceof ConversationClientError && cause.status === 409) {
        try { await reloadPersistedSelection(); } catch { /* preserve the conflict below */ }
        setError(selectionConflictMessage);
        throw new Error(selectionConflictMessage);
      }
      throw cause;
    }
  }, [agentId, client, isCurrentAgent, reloadPersistedSelection, selection]);

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
