'use client';

import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [
    organizationClient(),
    adminClient(),
    passkeyClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = '/admin/login?step=2fa';
      },
    }),
  ],
});

export const { useSession } = authClient;
