import { JmapRequestError } from '@postarix/jmap-client';
import { Spinner } from '@postarix/ui/components/spinner';
import { TooltipProvider } from '@postarix/ui/components/tooltip';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { jmap } from '@/lib/jmap';
import { navigate, useLinkInterception, useRoute } from '@/lib/router';
import { LoginPage } from '@/pages/login';
import { CalendarPage } from '@/pages/calendar';
import { ContactsPage } from '@/pages/contacts';
import { MailPage } from '@/pages/mail';
import './styles.css';
import { t } from '@/lib/i18n';
import { language } from './lib/i18n';

document.documentElement.lang = language;

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
    const secondFactor = mailbox.error instanceof JmapRequestError && mailbox.error.status === 403;
    if (secondFactor) {
      return (
        <Centered>
          <div className="max-w-sm space-y-2">
            <p className="text-base font-medium text-foreground">{t('Your organization requires two-step sign-in.')}</p>
            <p>{t('Set up an authenticator app or a passkey for your account, then come back.')}</p>
            <p>
              <a className="underline underline-offset-4" href="/admin/account">
                {t('Open your account settings')}
              </a>
            </p>
          </div>
        </Centered>
      );
    }
    const noMailbox = mailbox.error instanceof JmapRequestError && mailbox.error.status === 404;
    return (
      <Centered>
        <div className="space-y-2">
          <p className="text-base font-medium text-foreground">{noMailbox ? 'This account has no mailbox.' : 'The mail server is unavailable.'}</p>
          <p>
            {noMailbox ? (
              <a className="underline underline-offset-4" href="/admin/">
                {t('Open the admin panel')}
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
  const user = { email: session.user.email, name: session.user.name };
  if (route.name === 'calendar') return <CalendarPage date={route.date} view={route.view} {...user} />;
  if (route.name === 'contacts') return <ContactsPage contactId={route.contactId} search={route.search} {...user} />;
  return <MailPage mailboxId={route.mailboxId} emailId={route.emailId} search={route.search} label={route.label ?? null} {...user} />;
}

/** A rendering error shows a way out instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Centered>
        <div className="max-w-sm space-y-3">
          <p className="text-base font-medium text-foreground">{t('Something on this page could not be shown.')}</p>
          <p>
            <a className="underline underline-offset-4" href="/">
              {t('Back to the inbox')}
            </a>
          </p>
        </div>
      </Centered>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
