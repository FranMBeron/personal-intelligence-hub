"use client";

import { useId, useRef, useState } from "react";
import type { Conversation } from "@personal-intelligence-hub/contracts";

type AsyncAction = () => Promise<void>;
type ConversationAction = (id: string) => Promise<void>;

export function ThreadSelector({
  items, selectedId, onSelect, onCreate, onRename, onArchive, onRestore, loading,
  onLoadMore, hasMore = false, loadingMore = false,
}: Readonly<{
  items: readonly Conversation[];
  selectedId: string | null;
  onSelect: ConversationAction;
  onCreate: AsyncAction;
  onRename: (id: string, title: string) => Promise<void>;
  onArchive: ConversationAction;
  onRestore: ConversationAction;
  loading: boolean;
  onLoadMore?: AsyncAction;
  hasMore?: boolean;
  loadingMore?: boolean;
}>) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();

  const run = async (id: string, operation: () => Promise<void>) => {
    setError(null);
    setBusyId(id);
    try { await operation(); }
    catch (cause) {
      setError(cause instanceof Error && cause.message.startsWith("La selección se actualizó en otro lugar.")
        ? cause.message
        : "No se pudo guardar el cambio. La selección o conversación pudo cambiar en otro lugar.");
    }
    finally { setBusyId(null); }
  };

  const startRename = (item: Conversation) => {
    setError(null);
    setEditingId(item.id);
    setTitle(item.title);
    requestAnimationFrame(() => titleInput.current?.focus());
  };

  const loadNextPage = async () => {
    if (onLoadMore === undefined) return;
    await run("page", onLoadMore);
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]");
      if (buttons === undefined || buttons.length === 0) return;
      buttons.item(buttons.length - 1)?.focus();
    });
  };

  const saveRename = async (event: React.FormEvent<HTMLFormElement>, item: Conversation) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (nextTitle === "" || nextTitle === item.title) { setEditingId(null); return; }
    await run(item.id, async () => { await onRename(item.id, nextTitle); setEditingId(null); });
  };

  return (
    <section className="thread-selector" aria-label="Conversaciones">
      <div className="thread-selector__header">
        <div><p className="eyebrow">Hilos guardados</p><h2>Conversaciones</h2></div>
        <button className="button button--quiet" type="button" onClick={() => void run("create", onCreate)} disabled={busyId !== null || loading}>Nueva conversación</button>
      </div>
      {error === null ? null : <p role="alert" className="thread-selector__error">{error}</p>}
      {loading && items.length === 0 ? <p role="status">Cargando conversaciones…</p> : items.length === 0 ? (
        <p className="thread-selector__empty">Todavía no hay conversaciones guardadas.</p>
      ) : (
        <ul ref={listRef} className="thread-selector__list">
          {items.map((item) => {
            const archiveHelpId = `thread-archive-help-${item.id}`;
            return (
              <li key={item.id} className={item.id === selectedId ? "thread-selector__item is-selected" : "thread-selector__item"}>
                <div className="thread-selector__row">
                  <button className="thread-selector__select" type="button" aria-label={`Seleccionar ${item.title}`} aria-pressed={item.id === selectedId}
                    onClick={() => void run(item.id, () => onSelect(item.id))} disabled={busyId !== null || item.archived}>
                    <span>{item.title}</span>
                    {item.isMain ? <span className="thread-selector__badge">Principal</span> : null}
                    {item.archived ? <span className="thread-selector__badge">Archivada</span> : null}
                  </button>
                  {editingId === item.id ? (
                    <form className="thread-selector__rename" onSubmit={(event) => void saveRename(event, item)}>
                      <label className="sr-only" htmlFor={titleId}>Nuevo título para {item.title}</label>
                      <input ref={titleInput} id={titleId} aria-label={`Nuevo título para ${item.title}`} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
                      <button className="button button--quiet" type="submit" disabled={busyId !== null}>Guardar título</button>
                      <button className="button button--quiet" type="button" onClick={() => setEditingId(null)}>Cancelar</button>
                    </form>
                  ) : (
                    <div className="thread-selector__actions">
                      {!item.archived ? <button className="button button--quiet" type="button" aria-label={`Renombrar ${item.title}`} onClick={() => startRename(item)} disabled={busyId !== null}>Renombrar</button> : null}
                      {item.archived ? (
                        <button className="button button--quiet" type="button" aria-label={`Restaurar ${item.title}`} onClick={() => void run(item.id, () => onRestore(item.id))} disabled={busyId !== null}>Restaurar</button>
                      ) : (
                        <>
                          {/* Main thread: aria-disabled keeps the control focusable so its visible explanation stays reachable. */}
                          <button className="button button--quiet" type="button" aria-label={`Archivar ${item.title}`} aria-describedby={item.isMain ? archiveHelpId : undefined}
                            aria-disabled={item.isMain ? true : undefined} disabled={busyId !== null && !item.isMain}
                            onClick={() => { if (!item.isMain) void run(item.id, () => onArchive(item.id)); }}>Archivar</button>
                          {item.isMain ? <span id={archiveHelpId} className="thread-selector__hint">La conversación principal no se puede archivar.</span> : null}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && onLoadMore !== undefined ? <button className="button button--quiet" type="button" onClick={() => void loadNextPage()} disabled={loadingMore || busyId !== null}>{loadingMore ? "Cargando…" : "Cargar más conversaciones"}</button> : null}
    </section>
  );
}
