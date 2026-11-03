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

export interface Domain {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'disabled';
  verificationRecord: string;
  verifiedAt: string | null;
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
