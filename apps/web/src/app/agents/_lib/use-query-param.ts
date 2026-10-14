"use client";

import { useCallback, useSyncExternalStore } from "react";

const QUERY_CHANGE = "pih:query-change";

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener(QUERY_CHANGE, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(QUERY_CHANGE, notify);
  };
};

/**
 * One URL query parameter as shared UI state. Writes push a history entry
 * (Next.js integrates native pushState with its router), so back/forward
 * restore the previous value. The server snapshot is always `null`.
 */
export function useQueryParam(name: string): readonly [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );
  const update = useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete(name);
    else url.searchParams.set(name, next);
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (target === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    window.history.pushState(null, "", target);
    window.dispatchEvent(new Event(QUERY_CHANGE));
  }, [name]);
  return [value, update] as const;
}
