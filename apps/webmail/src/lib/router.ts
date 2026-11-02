import { useEffect, useSyncExternalStore } from 'react';

/**
 * A tiny router over the History API. Routes:
 *   /login                       sign-in
 *   /                            the inbox
 *   /m/<mailboxId>[/<emailId>]   a folder, optionally with an open message
 */
export type Route =
  | { name: 'login' }
  | { name: 'mailbox'; mailboxId: string | null; emailId: string | null; search: string };

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

export function navigate(path: string, replace = false): void {
  if (path === snapshot()) return;
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  for (const listener of listeners) listener();
}

export function parseRoute(location: string): Route {
  const url = new URL(location, 'http://local');
  if (url.pathname === '/login') return { name: 'login' };
  const match = /^\/m\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  return {
    name: 'mailbox',
    mailboxId: match?.[1] ? decodeURIComponent(match[1]) : null,
    emailId: match?.[2] ? decodeURIComponent(match[2]) : null,
    search: url.searchParams.get('q') ?? '',
  };
}

export function mailboxPath(mailboxId: string, emailId?: string | null, search?: string): string {
  const query = search ? `?q=${encodeURIComponent(search)}` : '';
  return `/m/${encodeURIComponent(mailboxId)}${emailId ? `/${encodeURIComponent(emailId)}` : ''}${query}`;
}

export function useRoute(): Route {
  const location = useSyncExternalStore(subscribe, snapshot);
  return parseRoute(location);
}

/** Intercepts clicks on same-origin <a data-nav> links so they use the router. */
export function useLinkInterception(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest('a[data-nav]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      navigate(anchor.pathname + anchor.search);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}
