import { readFileSync } from 'node:fs';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { Env } from '../config/env.js';
import { internalSecret } from '../config/internal-secrets.js';

/**
 * A connection to Postfix's internal submission port (10587), for the
 * webmail's outgoing mail and the server's own notices; null when sending is
 * not configured (no INTERNAL_API_TOKEN). Postfix requires STARTTLS there, and
 * its certificate is checked like Cyrus' (same certificate, name and CA
 * settings), so the password cannot be captured on the way. Made per message:
 * the CA file is read again, so a renewed certificate is trusted at once.
 */
export function createSubmissionTransport(env: Env) {
  const token = env.INTERNAL_API_TOKEN;
  if (!token) return null;
  return {
    sendMail: async (message: SendMailOptions) => {
      const transport = nodemailer.createTransport({
        host: env.SUBMISSION_HOST,
        port: env.SUBMISSION_PORT,
        secure: false,
        requireTLS: true,
        tls: {
          rejectUnauthorized: env.CYRUS_TLS_VERIFY,
          ...(env.CYRUS_TLS_SERVERNAME ? { servername: env.CYRUS_TLS_SERVERNAME } : {}),
          ...(env.CYRUS_TLS_CA_FILE ? { ca: readCa(env.CYRUS_TLS_CA_FILE) } : {}),
        },
        auth: { user: 'postarix-api', pass: internalSecret(token, 'submission') },
        connectionTimeout: 10_000,
        socketTimeout: 60_000,
      });
      try {
        return await transport.sendMail(message);
      } finally {
        transport.close();
      }
    },
  };
}

function readCa(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
