import path from 'node:path';
import type { NextConfig } from 'next';

// Where the Next.js server forwards /api requests. In production the reverse
// proxy usually routes /api itself; this keeps development and simple setups
// same-origin (cookies, no CORS). Next.js resolves rewrites when it builds, so
// this is a build-time setting (the Docker image uses http://api:3000).
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

const config: NextConfig = {
  basePath: '/admin',
  output: 'standalone',
  // Trace dependencies from the monorepo root so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@postarix/ui'],
  async rewrites() {
    return [
      {
        // Everything under /api except /api/internal, which must never be reachable.
        source: '/api/:path((?!internal(?:/|$)).*)',
        destination: `${apiUrl}/api/:path`,
        basePath: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Browsers only honour it over HTTPS (the reverse proxy's side).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
