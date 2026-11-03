export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrgRole | null;
  viaSuperAdmin?: boolean;
  counts: { domains: number; mailboxes: number; aliases: number; members: number };
  createdAt: string;
}

/** Spam thresholds; null: inherited. */
export interface SpamScores {
  junkScore: number | null;
  rejectScore: number | null;
}

/** A sending limit: messages per period. */
export interface RateLimit {
  messages: number;
  per: 'second' | 'minute' | 'hour' | 'day';
}

export interface Domain {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'disabled';
  verificationRecord: string;
  verifiedAt: string | null;
  /** An alias domain: it repeats every address of this domain. */
  aliasOfDomainId: string | null;
  description: string;
  defaultMailboxQuotaBytes: number | null;
  /** Set by instance administrators; null: no limit. */
  limits: {
    maxMailboxes: number | null;
    maxAliases: number | null;
    maxMailboxQuotaBytes: number | null;
    totalQuotaBytes: number | null;
  };
  usage: { mailboxes: number; aliases: number; quotaBytes: number; unlimitedMailboxes: number };
  /** For each of its mailboxes, unless the mailbox has its own. */
  rateLimit: RateLimit | null;
  /** Smart host its mail goes through (instance administrators set it). */
  relayHostId: string | null;
  spamScores: SpamScores;
  createdAt: string;
}

export interface DnsRecord {
  purpose: 'verification' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'autoconfig' | 'mta-sts' | 'mta-sts-id';
  type: 'TXT' | 'MX' | 'CNAME';
  name: string;
  value: string;
}

export interface DnsRecordCheck extends DnsRecord {
  status: 'ok' | 'missing' | 'mismatch' | 'unknown';
  found: string[];
}

export interface Mailbox {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  displayName: string;
  quotaBytes: number | null;
  /** no_login: receives mail, but nobody can sign in. */
  status: 'active' | 'no_login' | 'disabled';
  allowedProtocols: ('imap' | 'pop3' | 'smtp' | 'sieve' | 'dav')[];
  tlsRequiredIn: boolean;
  tlsRequiredOut: boolean;
  /** Null: its domain's limit, if any. */
  rateLimit: RateLimit | null;
  relayHostId: string | null;
  spamScores: SpamScores;
  /** How often its people hear about quarantined mail. */
  quarantineNotify: 'never' | 'hourly' | 'daily' | 'weekly';
  /** Rooms and equipment answer calendar invitations by themselves. */
  kind: 'person' | 'room' | 'equipment';
  createdAt: string;
}

export interface Alias {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  destinations: string[];
  enabled: boolean;
  /** Accepts mail and drops it. */
  discard: boolean;
  /** "@domain": every address of the domain that is not a mailbox or another alias. */
  catchAll: boolean;
}

export interface Member {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  targetType: string;
  targetLabel: string | null;
  actorEmail: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AppPassword {
  id: string;
  name: string;
  scopes: ('imap' | 'smtp' | 'dav')[];
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SsoProvider {
  id: string;
  type: 'oidc' | 'saml';
  providerId: string;
  domain: string;
  issuer: string;
  clientId: string;
  callbackUrl: string;
  entityId: string | null;
  certificateExpiresAt: string | null;
}

export interface MailLogEntry {
  id: string;
  time: string;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  subject: string;
  outcome: 'delivered' | 'spam' | 'greylisted' | 'deferred' | 'rejected';
  score: number;
  requiredScore: number;
  reasons: { name: string; score: number }[];
  ip: string | null;
}
