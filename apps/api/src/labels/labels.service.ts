import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { mailLabels } from '../db/schema/index.js';

export const createLabelSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\r\n]*$/),
});

export interface LabelDto {
  id: string;
  name: string;
  keyword: string;
}

const MAX_LABELS = 100;

/** The keyword for a label name: "label-" and a lowercase slug (an IMAP flag atom). */
export function labelKeyword(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `label-${slug || 'x'}`;
}

/** The signed-in person's labels (their own data: looked up by user ID). */
@Injectable()
export class LabelsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(userId: string): Promise<LabelDto[]> {
    return this.db
      .select({ id: mailLabels.id, name: mailLabels.name, keyword: mailLabels.keyword })
      .from(mailLabels)
      .where(eq(mailLabels.userId, userId))
      .orderBy(asc(mailLabels.name));
  }

  async create(userId: string, name: string): Promise<LabelDto> {
    const [{ value: total } = { value: 0 }] = await this.db.select({ value: count() }).from(mailLabels).where(eq(mailLabels.userId, userId));
    if (total >= MAX_LABELS) throw new UnprocessableEntityException(`At most ${MAX_LABELS} labels`);
    const keyword = labelKeyword(name);
    const rows = await this.db
      .insert(mailLabels)
      .values({ userId, name, keyword })
      .onConflictDoNothing()
      .returning({ id: mailLabels.id, name: mailLabels.name, keyword: mailLabels.keyword });
    if (!rows[0]) throw new ConflictException('A label with that name exists');
    return rows[0];
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(mailLabels)
      .where(and(eq(mailLabels.userId, userId), eq(mailLabels.id, id)))
      .returning({ id: mailLabels.id });
    if (rows.length === 0) throw new NotFoundException('Label not found');
  }
}
