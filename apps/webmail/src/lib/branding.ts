import { useEffect, useState } from 'react';

export interface Branding {
  productName: string;
  loginMessage: string;
  announcement: string;
  supportUrl: string;
  announcementLevel?: 'info' | 'important' | 'urgent';
  footer?: string;
  /** A data: URL replacing the stamp; empty: the stamp. */
  logo?: string;
  appLinks?: { name: string; url: string }[];
  hidePasswordSignIn?: boolean;
}

let cached: Promise<Branding | null> | null = null;

/** What the server's administrators set for the sign-in page and everyone's screens (fetched once). */
export function useBranding(): Branding | null {
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    cached ??= fetch('/api/branding', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<Branding>) : null))
      .catch(() => null);
    let alive = true;
    void cached.then((value) => {
      if (alive) setBranding(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return branding;
}
