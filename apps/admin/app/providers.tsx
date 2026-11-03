'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { browserLanguage, language, setLanguage } from '@/lib/i18n';

export function Providers({ children, serverLanguage }: { children: ReactNode; serverLanguage: string }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            // Don't retry client errors (401, 403, 404…): they won't fix themselves.
            retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  // The server renders in English only: in another language the page is
  // rendered in the browser alone, so server and browser never disagree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // First visit: follow the browser's language (once; then the cookie decides).
    const preferred = browserLanguage();
    if (preferred) setLanguage(preferred);
    else setMounted(true);
  }, []);
  const translated = language !== 'en' || serverLanguage !== 'en';
  if (translated && !mounted) return null;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
