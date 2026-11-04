'use client';

import { Button } from '@postarix/ui/components/button';
import { UserRoundCog } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { t } from '@/lib/i18n';

/** While inside someone's mailbox ("Sign in as"), the panel is theirs: say so, and offer the way back. */
export function ImpersonationBanner() {
  const { data } = useSession();
  const [leaving, setLeaving] = useState(false);
  const session = data?.session as { impersonatedBy?: string | null; expiresAt?: string | Date } | undefined;
  if (!data || !session?.impersonatedBy) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-stamp px-4 py-2 text-sm font-medium text-stamp-foreground md:px-8">
      <UserRoundCog className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t('You are in {address}’s mailbox as an administrator. Its mail is in the webmail; administration is closed until you leave.').replace('{address}', data.user.email)}
      </span>
      <Button size="sm" variant="outline" className="h-7 bg-transparent" onClick={() => window.location.assign('/')}>
        {t('Open the webmail')}
      </Button>
      <Button
        size="sm"
        disabled={leaving}
        onClick={async () => {
          setLeaving(true);
          try {
            await api.post('/me/impersonation/stop');
          } finally {
            window.location.assign('/admin');
          }
        }}
      >
        {t('Leave')}
      </Button>
    </div>
  );
}
