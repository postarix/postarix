import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { Env } from '../config/env.js';
import { secretFor } from '../config/internal-secrets.js';

/**
 * A connection to Postfix's internal submission port (10587), for the
 * webmail's outgoing mail and the server's own notices; null when sending is
 * not configured (no internal secrets). Postfix requires STARTTLS there, and
 * its certificate is checked like Cyrus' (same certificate, name and CA
 * settings), so the password cannot be captured on the way. Made per message:
 * the CA file is read again, so a renewed certificate is trusted at once.
 */
export function createSubmissionTransport(env: Env) {
  const password = secretFor(env, 'submission');
  if (!password) return null;
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
          ...trustedCa(env.CYRUS_TLS_CA_FILE),
        },
        auth: { user: 'postarix-api', pass: password },
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

/**
 * The certificates to trust: the system's roots plus the file's. The file is
 * Postfix' own certificate chain: self-signed, it is its own anchor; from a
 * public CA (Let's Encrypt), it holds no root, and the chain is checked up to
 * the system's roots. Given alone, it would replace them and a public chain
 * could never be verified.
 */
export function trustedCa(path: string | undefined): { ca?: string[] } {
  const extra = path ? readCa(path) : undefined;
  return extra ? { ca: [...rootCertificates, extra] } : {};
}

function readCa(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
