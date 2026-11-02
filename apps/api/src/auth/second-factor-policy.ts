import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';

export interface SecondFactorStatus {
  /** An organization the person belongs to requires a second factor. */
  required: boolean;
  /** They have one: an authenticator app (TOTP) or a passkey. */
  enrolled: boolean;
  /**
   * This session proves more than a password: opened with a passkey, a second
   * factor or the identity provider, or the account always asks for an
   * authenticator code after the password. Only set when a session is given.
   */
  strongSession?: boolean;
}

/** The error code clients receive until they set up a second factor. */
export const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED';

/**
 * Organizations may require every member and mailbox owner to use a second
 * factor. Until they set one up, people under such a rule can only reach
 * their account security settings (Better Auth's own endpoints) and the few
 * API routes marked with @AllowWithoutSecondFactor: no mail, no calendar, no
 * administration, and their account password does not open IMAP/SMTP/DAV.
 */
@Injectable()
export class SecondFactorPolicy {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async status(userId: string, sessionId?: string): Promise<SecondFactorStatus> {
    const result = await this.db.execute<{ required: boolean; enrolled: boolean; totp: boolean; strong: boolean }>(sql`
      SELECT
        COALESCE((SELECT two_factor_enabled FROM "user" WHERE id = ${userId}), false) AS totp,
        EXISTS (SELECT 1 FROM session_factors WHERE session_id = ${sessionId ?? ''}) AS strong,
        EXISTS (
          SELECT 1 FROM organization_security s
          WHERE s.require_second_factor
            AND (
              s.organization_id IN (SELECT organization_id FROM member WHERE user_id = ${userId})
              OR s.organization_id IN (SELECT organization_id FROM mailboxes WHERE user_id = ${userId})
            )
        ) AS required,
        (
          COALESCE((SELECT two_factor_enabled FROM "user" WHERE id = ${userId}), false)
          OR EXISTS (SELECT 1 FROM passkey WHERE user_id = ${userId})
        ) AS enrolled
    `);
    const row = result.rows[0];
    return {
      required: Boolean(row?.required),
      enrolled: Boolean(row?.enrolled),
      ...(sessionId === undefined ? {} : { strongSession: Boolean(row?.totp) || Boolean(row?.strong) }),
    };
  }

  /**
   * True when this session may use the API normally: no rule applies, or the
   * session was opened with more than a password (a passkey alone does not
   * help if the person signed in with their password).
   */
  async satisfied(userId: string, sessionId: string): Promise<boolean> {
    const { required, strongSession } = await this.status(userId, sessionId);
    return !required || Boolean(strongSession);
  }
}
