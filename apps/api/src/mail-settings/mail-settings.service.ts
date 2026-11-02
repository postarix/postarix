import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { type MailEngine, MailEngineError } from '@postarix/mail-engine';
import { engineErrorToHttp } from '../common/engine-errors.js';
import { DATABASE, MAIL_ENGINE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { findOwnMailbox } from '../jmap/my-mailbox.js';
import { type MailSettings, parseSettingsScript, renderSettingsScript, SETTINGS_SCRIPT } from './sieve-settings.js';

export interface MailSettingsDto extends MailSettings {
  /** A filter set up in a mail app (ManageSieve) is active; saving settings here replaces it. */
  otherFiltersActive: boolean;
}

/**
 * The signed-in user's automatic reply and forwarding, kept as a Sieve script
 * of their own mailbox (and nowhere else). What the server lets that script
 * send is bounded by Rspamd (vacation from the mailbox's own address only,
 * forwarding limited and never for spam).
 */
@Injectable()
export class MailSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAIL_ENGINE) private readonly engine: MailEngine,
  ) {}

  private async mailbox(userId: string): Promise<string> {
    const address = await findOwnMailbox(this.db, userId);
    if (!address) throw new NotFoundException('You have no mailbox');
    return address;
  }

  async get(userId: string): Promise<MailSettingsDto> {
    const address = await this.mailbox(userId);
    try {
      const scripts = await this.engine.listSieveScripts(address);
      const ours = scripts.find((s) => s.name === SETTINGS_SCRIPT);
      const settings = parseSettingsScript(ours ? await this.engine.readSieveScript(address, SETTINGS_SCRIPT) : null);
      return {
        ...settings,
        // Not active means a mail app activated another script since.
        vacation: { ...settings.vacation, enabled: settings.vacation.enabled && Boolean(ours?.active) },
        forwarding: { ...settings.forwarding, enabled: settings.forwarding.enabled && Boolean(ours?.active) },
        otherFiltersActive: scripts.some((s) => s.active && s.name !== SETTINGS_SCRIPT),
      };
    } catch (error) {
      throw engineErrorToHttp(error);
    }
  }

  async update(userId: string, settings: MailSettings): Promise<MailSettingsDto> {
    const address = await this.mailbox(userId);
    if (settings.forwarding.enabled && settings.forwarding.address.toLowerCase() === address) {
      throw new UnprocessableEntityException('Mail cannot be forwarded to the same mailbox');
    }
    const script = renderSettingsScript(settings);
    try {
      if (script) await this.engine.writeSieveScript(address, SETTINGS_SCRIPT, script, { activate: true });
      else await this.engine.deleteSieveScript(address, SETTINGS_SCRIPT);
    } catch (error) {
      if (error instanceof MailEngineError && error.code === 'rejected') {
        throw new UnprocessableEntityException('The mail server refused these settings');
      }
      throw engineErrorToHttp(error);
    }
    return this.get(userId);
  }
}
