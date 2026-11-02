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
  createdAt: string;
}

export interface DnsRecord {
  purpose: 'verification' | 'mx' | 'spf' | 'dkim' | 'dmarc';
  type: 'TXT' | 'MX';
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
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface Alias {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  destinations: string[];
  enabled: boolean;
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
