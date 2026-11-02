import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/session.js';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Public()
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: 'error' });
    }
    return { status: 'ok' };
  }
}
