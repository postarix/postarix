import { Logger } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { createSubmissionTransport } from './submission-transport.js';

export interface SystemMessage {
  to: string;
  subject: string;
  text: string;
  /** Instead of SYSTEM_MAIL_FROM. */
  from?: string | undefined;
  /** A blind copy. */
  bcc?: string | undefined;
}

/** Notices the server itself sends to people (plain text, from SYSTEM_MAIL_FROM). */
export interface SystemMailer {
  /** Best effort: a notice that cannot be sent is logged, never thrown. */
  send(message: SystemMessage): Promise<void>;
}

export class SmtpSystemMailer implements SystemMailer {
  private readonly logger = new Logger('SystemMailer');
  private readonly transport;

  constructor(private readonly env: Env) {
    this.transport = createSubmissionTransport(env);
  }

  async send(message: SystemMessage): Promise<void> {
    if (!this.transport) return;
    const from = message.from || (this.env.SYSTEM_MAIL_FROM ?? `no-reply@${this.env.MAIL_HOSTNAME}`);
    try {
      await this.transport.sendMail({
        from: { name: 'Postarix', address: from },
        envelope: { from, to: message.bcc ? [message.to, message.bcc] : message.to },
        to: message.to,
        subject: message.subject,
        text: message.text,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (error) {
      this.logger.warn(`Could not send "${message.subject}" to ${message.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** For development and tests (MAIL_ENGINE=memory): keeps the notices. */
export class MemorySystemMailer implements SystemMailer {
  readonly sent: SystemMessage[] = [];

  async send(message: SystemMessage): Promise<void> {
    this.sent.push(message);
  }
}
