import { createHmac, timingSafeEqual } from 'node:crypto';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';

/** How long an administrator may stay in someone's mailbox. */
export const IMPERSONATION_MS = 60 * 60 * 1000;

/** The session-factor marker of a session opened by "Sign in as". */
export const IMPERSONATION_FACTOR = 'impersonation';

/**
 * A grant the API mints after its checks (who may, which mailbox, the reason,
 * the audit record): the auth endpoint below accepts nothing else, so the
 * endpoint cannot be used to skip those checks even if reached directly.
 * It names the administrator's session and the target, and expires in a minute.
 */
export function mintImpersonationGrant(secret: string, actorSessionId: string, targetUserId: string, now = Date.now()): string {
  const expires = now + 60_000;
  const payload = `${actorSessionId}:${targetUserId}:${expires}`;
  const mac = createHmac('sha256', secret).update(`postarix-impersonation:${payload}`).digest('base64url');
  return `${expires}.${mac}`;
}

function grantValid(secret: string, grant: string, actorSessionId: string, targetUserId: string, now = Date.now()): boolean {
  const [expiresText, mac] = grant.split('.');
  const expires = Number(expiresText);
  if (!mac || !Number.isFinite(expires) || expires < now) return false;
  const expected = createHmac('sha256', secret)
    .update(`postarix-impersonation:${actorSessionId}:${targetUserId}:${expires}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * "Sign in as": opens a one-hour session as the mailbox's owner for the
 * administrator, and keeps theirs to come back to, exactly like Better Auth's
 * admin impersonation (whose own endpoint is closed: it has no reason, no
 * organization rules and no audit record). Ending it is Better Auth's
 * /admin/stop-impersonating.
 */
export function postarixImpersonation(secret: string, onCreated: (sessionId: string) => Promise<void>) {
  return {
    id: 'postarix-impersonation',
    endpoints: {
      postarixImpersonate: createAuthEndpoint(
        '/postarix/impersonate',
        {
          method: 'POST',
          body: z.object({ targetUserId: z.string().min(1).max(100), grant: z.string().min(1).max(200) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const actor = ctx.context.session;
          if (!grantValid(secret, ctx.body.grant, actor.session.id, ctx.body.targetUserId)) {
            throw new APIError('FORBIDDEN', { message: 'Not allowed' });
          }
          const target = await ctx.context.internalAdapter.findUserById(ctx.body.targetUserId);
          if (!target) throw new APIError('NOT_FOUND', { message: 'No such account' });
          const session = await ctx.context.internalAdapter.createSession(
            target.id,
            true,
            { impersonatedBy: actor.user.id, expiresAt: new Date(Date.now() + IMPERSONATION_MS) },
            true,
          );
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not open the session' });
          await onCreated(session.id);
          const dontRemember = await ctx.getSignedCookie(ctx.context.authCookies.dontRememberToken.name, ctx.context.secret);
          deleteSessionCookie(ctx);
          const adminCookie = ctx.context.createAuthCookie('admin_session');
          await ctx.setSignedCookie(
            adminCookie.name,
            `${actor.session.token}:${dontRemember || ''}`,
            ctx.context.secret,
            ctx.context.authCookies.sessionToken.attributes,
          );
          await setSessionCookie(ctx, { session, user: target }, true);
          return ctx.json({ expiresAt: session.expiresAt });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

/** Better Auth routes closed to a "Sign in as" session: its account's security and administration. */
export function closedWhileImpersonating(path: string): boolean {
  if (path === '/admin/stop-impersonating' || path === '/sign-out' || path === '/get-session') return false;
  return (
    path.startsWith('/admin/') ||
    path.startsWith('/two-factor/') ||
    path.startsWith('/passkey/') ||
    path.startsWith('/organization/') ||
    path.startsWith('/postarix/') ||
    [
      '/change-password',
      '/set-password',
      '/change-email',
      '/update-user',
      '/delete-user',
      '/revoke-session',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/list-sessions',
      '/link-social',
      '/unlink-account',
      '/list-accounts',
    ].includes(path)
  );
}

/** API routes a "Sign in as" session may use: the mailbox's mail, calendar and settings, not its account's. */
export function openWhileImpersonating(path: string): boolean {
  const p = path.replace(/\/+$/, '');
  if (p === '/api/me/app-passwords' || p.startsWith('/api/me/app-passwords/')) return false;
  if (p === '/api/me/second-factor' || p.startsWith('/api/me/second-factor/')) return false;
  if (p === '/api/me/organizations' || p.startsWith('/api/me/organizations/')) return false;
  return p.startsWith('/api/mail') || p.startsWith('/api/calendar') || p.startsWith('/api/me/') || p === '/api/branding';
}
