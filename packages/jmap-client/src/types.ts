/** Subset of the JMAP data model (RFC 8620, RFC 8621) used by the webmail. */

export type Id = string;

export interface Session {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  username: string;
  state: string;
  capabilities: Record<string, unknown>;
  accounts: Record<Id, { name: string; isPersonal: boolean; isReadOnly: boolean; accountCapabilities: Record<string, unknown> }>;
  primaryAccounts: Record<string, Id>;
}

export interface EmailAddress {
  name?: string | null;
  email: string;
}

export type MailboxRole = 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive' | 'important' | 'all' | 'flagged' | null;

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
}

export interface EmailBodyPart {
  partId?: string | null;
  blobId?: Id | null;
  type: string;
  name?: string | null;
  size?: number;
  cid?: string | null;
  disposition?: string | null;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  sentAt?: string | null;
  subject?: string | null;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  preview?: string;
  hasAttachment?: boolean;
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
}

export interface MethodError {
  type: string;
  description?: string;
}

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

/** A reference to the result of an earlier call in the same request (RFC 8620 §3.7). */
export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}

export const CAPABILITIES = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
} as const;
