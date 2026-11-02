import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import { internalSecret } from '../config/internal-secrets.js';

/**
 * The API's connection to Postfix's internal submission port (10587): the
 * webmail's outgoing mail and the server's own notices. Null when sending is
 * not configured (no INTERNAL_API_TOKEN).
 */
export function createSubmissionTransport(env: Env) {
  if (!env.INTERNAL_API_TOKEN) return null;
  return nodemailer.createTransport({
    host: env.SUBMISSION_HOST,
    port: env.SUBMISSION_PORT,
    secure: false,
    // Postfix requires STARTTLS on 10587 so the password is never sent in
    // clear over the internal network. Its certificate is for the public mail
    // name (or self-signed), not for this internal host name.
    requireTLS: true,
    tls: { rejectUnauthorized: false },
    auth: { user: 'postarix-api', pass: internalSecret(env.INTERNAL_API_TOKEN, 'submission') },
    connectionTimeout: 10_000,
    socketTimeout: 60_000,
  });
}
