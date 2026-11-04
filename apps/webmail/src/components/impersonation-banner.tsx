import { Button } from '@postarix/ui/components/button';
import { UserRoundCog } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { t } from '@/lib/i18n';

/** Shown while an administrator is inside this mailbox ("Sign in as"), with the way out. */
export function ImpersonationBanner() {
  const { data } = useSession();
  const [leaving, setLeaving] = useState(false);
  const session = data?.session as { impersonatedBy?: string | null; expiresAt?: string | Date } | undefined;
  if (!data || !session?.impersonatedBy) return null;
  const until = session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-stamp px-4 py-2 text-sm font-medium text-stamp-foreground">
      <UserRoundCog className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t('You are in {address}’s mailbox as an administrator, until {time}.').replace('{address}', data.user.email).replace('{time}', until)}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-stamp-foreground/30 bg-transparent text-stamp-foreground hover:bg-stamp-foreground/10"
        disabled={leaving}
        onClick={async () => {
          setLeaving(true);
          try {
            await api('/me/impersonation/stop', { method: 'POST' });
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
