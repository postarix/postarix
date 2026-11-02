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

/** A calendar (JMAP Calendars). */
export interface Calendar {
  id: Id;
  name: string;
  color?: string | null;
  sortOrder: number;
  isVisible: boolean;
  myRights?: { mayReadItems?: boolean; mayWriteAll?: boolean; mayDelete?: boolean };
}

/** Someone taking part in an event (JSCalendar, RFC 8984 §4.4.6). */
export interface Participant {
  '@type'?: 'Participant';
  name?: string | null;
  email?: string | null;
  sendTo?: Record<string, string> | null;
  roles?: Record<string, boolean> | null;
  participationStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated' | null;
}

export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule';
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly';
  interval?: number;
  count?: number;
  until?: string;
}

/** A calendar event (JSCalendar, RFC 8984, as served by JMAP Calendars). */
export interface CalendarEvent {
  id: Id;
  uid?: string;
  calendarIds: Record<Id, boolean>;
  title: string;
  description?: string | null;
  /** Local date-time ("2026-11-10T10:00:00") in `timeZone`, or floating when null. */
  start: string;
  timeZone?: string | null;
  /** ISO 8601 duration ("PT1H", "P1D"). */
  duration?: string;
  showWithoutTime?: boolean;
  locations?: Record<string, { '@type'?: 'Location'; name?: string }> | null;
  recurrenceRules?: RecurrenceRule[] | null;
  /** For expanded occurrences: the recurrence id and the master event id. */
  recurrenceId?: string | null;
  baseEventId?: Id | null;
  /** Invited people, the organizer included; set by the server (Postarix' calendar API). */
  participants?: Record<Id, Participant> | null;
  /** Where replies go: { imip: "mailto:organizer@…" }. */
  replyTo?: Record<string, string> | null;
}

/** A contact (Cyrus' JMAP contacts model, stored as vCard for CardDAV). */
export interface Contact {
  id: Id;
  addressbookId?: Id;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  nickname: string;
  notes: string;
  emails: { type: string; value: string; isDefault?: boolean; label?: string | null }[];
  phones: { type: string; value: string; label?: string | null }[];
}

export const CAPABILITIES = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  calendars: 'urn:ietf:params:jmap:calendars',
  contacts: 'https://cyrusimap.org/ns/jmap/contacts',
} as const;
