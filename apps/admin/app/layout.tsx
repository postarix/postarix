import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Postarix Admin', template: '%s · Postarix Admin' },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers renders every page per request, which lets Next.js
  // attach the CSP nonce (set in proxy.ts) to its scripts.
  await headers();
  const language = (await cookies()).get('postarix-lang')?.value === 'es' ? 'es' : 'en';
  return (
    <html lang={language}>
      <body className="min-h-screen">
        <Providers serverLanguage={language}>{children}</Providers>
      </body>
    </html>
  );
}
