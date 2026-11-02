import { JmapRequestError } from '@postarix/jmap-client';
import { Spinner } from '@postarix/ui/components/spinner';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { jmap } from '@/lib/jmap';
import { navigate, useLinkInterception, useRoute } from '@/lib/router';
import { LoginPage } from '@/pages/login';
import { MailPage } from '@/pages/mail';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => {
        const status = error instanceof ApiError || error instanceof JmapRequestError ? error.status : 500;
        return status >= 500 && count < 2;
      },
    },
  },
});

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function App() {
  useLinkInterception();
  const route = useRoute();
  const { data: session, isPending } = useSession();
  const mailbox = useQuery({ queryKey: ['jmap-session'], queryFn: () => jmap.session(), enabled: Boolean(session), retry: false });

  useEffect(() => {
    if (!isPending && !session && route.name !== 'login') navigate('/login', true);
    if (!isPending && session && route.name === 'login') navigate('/', true);
  }, [isPending, session, route.name]);

  if (route.name === 'login') return isPending ? null : <LoginPage />;
  if (isPending || !session) {
    return (
      <Centered>
        <Spinner className="size-6" />
      </Centered>
    );
  }
  if (mailbox.error) {
    const noMailbox = mailbox.error instanceof JmapRequestError && mailbox.error.status === 404;
    return (
      <Centered>
        <div className="space-y-2">
          <p className="text-base font-medium text-foreground">{noMailbox ? 'This account has no mailbox.' : 'The mail server is unavailable.'}</p>
          <p>
            {noMailbox ? (
              <a className="underline underline-offset-4" href="/admin/">
                Open the admin panel
              </a>
            ) : (
              'Try again in a moment.'
            )}
          </p>
        </div>
      </Centered>
    );
  }
  if (!mailbox.data) {
    return (
      <Centered>
        <Spinner className="size-6" />
      </Centered>
    );
  }
  return <MailPage mailboxId={route.mailboxId} emailId={route.emailId} search={route.search} email={session.user.email} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
