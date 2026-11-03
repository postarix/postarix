import { Redis } from 'ioredis';

/** Services that send their logs (and, for Postfix, the mail queue) to the API. */
export const reportingServices = ['postfix', 'cyrus', 'rspamd', 'unbound', 'clamav', 'crowdsec', 'certs'] as const;
export type ReportingService = (typeof reportingServices)[number];
/** Everything whose log the admin panel shows: the reporting services and the API itself. */
export const logServices = ['api', ...reportingServices] as const;
export type LogService = (typeof logServices)[number];

/** What a mail container says about itself with each report. */
export interface Heartbeat {
  at: string;
  version: string | null;
  host: string | null;
}

export interface QueueSnapshot {
  at: string;
  /** One JSON object per message, as `postqueue -j` prints them. */
  items: unknown[];
}

/**
 * Recent logs, the last mail queue snapshot and queue actions waiting for
 * Postfix, shared by every API instance (Valkey; memory in tests).
 */
export interface SystemStore {
  appendLog(service: LogService, lines: string[]): Promise<void>;
  readLog(service: LogService, limit: number): Promise<string[]>;
  setHeartbeat(service: ReportingService, heartbeat: Heartbeat): Promise<void>;
  heartbeat(service: ReportingService): Promise<Heartbeat | null>;
  setQueue(snapshot: QueueSnapshot): Promise<void>;
  queue(): Promise<QueueSnapshot | null>;
  pushQueueAction(action: string): Promise<void>;
  /** Removes and returns the waiting actions, oldest first. */
  takeQueueActions(): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Lines kept per service. */
export const LOG_LINES_KEPT = 5000;
const HEARTBEAT_TTL_S = 300;
const QUEUE_TTL_S = 300;
const ACTIONS_TTL_S = 600;

export class ValkeySystemStore implements SystemStore {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3, keyPrefix: 'postarix:system:' });
  }

  async appendLog(service: LogService, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    await this.client.multi().rpush(`logs:${service}`, ...lines).ltrim(`logs:${service}`, -LOG_LINES_KEPT, -1).exec();
  }

  readLog(service: LogService, limit: number): Promise<string[]> {
    return this.client.lrange(`logs:${service}`, -limit, -1);
  }

  async setHeartbeat(service: ReportingService, heartbeat: Heartbeat): Promise<void> {
    await this.client.set(`heartbeat:${service}`, JSON.stringify(heartbeat), 'EX', HEARTBEAT_TTL_S);
  }

  async heartbeat(service: ReportingService): Promise<Heartbeat | null> {
    const value = await this.client.get(`heartbeat:${service}`);
    return value ? (JSON.parse(value) as Heartbeat) : null;
  }

  async setQueue(snapshot: QueueSnapshot): Promise<void> {
    await this.client.set('queue', JSON.stringify(snapshot), 'EX', QUEUE_TTL_S);
  }

  async queue(): Promise<QueueSnapshot | null> {
    const value = await this.client.get('queue');
    return value ? (JSON.parse(value) as QueueSnapshot) : null;
  }

  async pushQueueAction(action: string): Promise<void> {
    await this.client.multi().rpush('queue-actions', action).expire('queue-actions', ACTIONS_TTL_S).exec();
  }

  async takeQueueActions(): Promise<string[]> {
    const result = await this.client.multi().lrange('queue-actions', 0, -1).del('queue-actions').exec();
    return (result?.[0]?.[1] as string[] | undefined) ?? [];
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

export class MemorySystemStore implements SystemStore {
  readonly logs = new Map<LogService, string[]>();
  readonly heartbeats = new Map<ReportingService, Heartbeat>();
  snapshot: QueueSnapshot | null = null;
  actions: string[] = [];

  async appendLog(service: LogService, lines: string[]): Promise<void> {
    const log = [...(this.logs.get(service) ?? []), ...lines];
    this.logs.set(service, log.slice(-LOG_LINES_KEPT));
  }

  async readLog(service: LogService, limit: number): Promise<string[]> {
    return (this.logs.get(service) ?? []).slice(-limit);
  }

  async setHeartbeat(service: ReportingService, heartbeat: Heartbeat): Promise<void> {
    this.heartbeats.set(service, heartbeat);
  }

  async heartbeat(service: ReportingService): Promise<Heartbeat | null> {
    return this.heartbeats.get(service) ?? null;
  }

  async setQueue(snapshot: QueueSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  async queue(): Promise<QueueSnapshot | null> {
    return this.snapshot;
  }

  async pushQueueAction(action: string): Promise<void> {
    this.actions.push(action);
  }

  async takeQueueActions(): Promise<string[]> {
    const taken = this.actions;
    this.actions = [];
    return taken;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
