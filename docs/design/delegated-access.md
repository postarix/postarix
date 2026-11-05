# Design: external identities, shared mailboxes and connected applications

Status: **approved** (2026-11-04), with the owner's changes folded in. Linked from [ARCHITECTURE.md](../ARCHITECTURE.md).

These three features let another web application (a helpdesk, a CRM, a company
intranet…) be the mail client of its own users. Postarix stays the mail server,
and access is still decided by Postarix and enforced by Cyrus. Nothing here is
specific to one installation.

| Part | What it adds | Depends on |
|---|---|---|
| P0 | Ending open IMAP/POP/JMAP sessions when access ends (a fix found while probing) | — |
| P1 | External identities: `(issuer, subject)` pairs linked to a user | — |
| P2 | Shared mailboxes with members and rights | P0 |
| P3 | Connected applications: short-lived tokens to act as a user, and supervision | P1, P2 |

Each part ships as its own pull request with migrations, tests and documentation.

## What Cyrus does today (probed on the Compose stack, Cyrus 3.10.2 from Debian trixie)

These were checked against the running stack before relying on them:

1. **JMAP.** With an ACL on another user's mailbox, Cyrus lists that user as an
   extra account in the JMAP session (`isPersonal: false`, the mail capability,
   `myRights` per mailbox following the ACL). The account disappears from the
   session as soon as the ACL is removed. Today the proxy passes every listed
   account through (only calendars and address books are shared, so far).
2. **IMAP.** The shared user's folders appear under the other-users namespace
   (`Other Users/team`, `Other Users/team/Sent`) and can be selected, read and
   changed within the granted rights.
3. **Removing an ACL does not end an open IMAP session that has the folder
   selected:** SEARCH and FETCH kept working on it after `DELETEACL`.
4. **Disabling a mailbox does not end its open IMAP sessions** (a security bug
   in every installation today): an IDLE connection stayed open for more than a
   minute after the mailbox was disabled, and STATUS still answered. Only new
   logins are refused (the login bridge checks the mailbox status).
5. **`cyr_deny <user>` ends all of that user's sessions** (the IDLE connection
   closed at once), but refuses new logins until `cyr_deny -a`, and takes a few
   seconds. Sending TERM to the user's processes listed in `/run/cyrus/proc`
   ends them just as well, with no refusal window.

## P0. Ending open sessions when access ends

Postarix will ask Cyrus to end a user's sessions whenever their access shrinks:
the mailbox is disabled, set to "no login" or deleted; the account is banned or
deleted; an app password is revoked; the password is changed; a member leaves a
shared mailbox or loses rights in it.

How, keeping the rule that the API never reaches into the mail containers:

- The API stores a **disconnect request** (the Cyrus user id and why) in
  PostgreSQL (`session_disconnects`, an increasing id), and publishes a wake-up
  on Valkey. Requests are never lost while a Cyrus node is down.
- A small loop in the Cyrus container (next to `postarix-reporter`, same TLS and
  secret) **long-polls** `/api/internal/sessions/disconnects?node=<name>` on the
  API's internal listener. The API answers as soon as there are requests newer
  than that node's cursor (or after 25 s with nothing), so the delay is about a
  second.
- For each address the loop ends that user's sessions: every Cyrus service
  process registers its user in Cyrus' process registry (`/run/cyrus/proc`), and
  a TERM signal makes it close its connection gracefully. (`cyr_deny` does the
  same, but also refuses new logins for the seconds it takes, which mail apps
  count as failed logins.) New logins are decided by the login bridge as usual.
  Then it acknowledges up to the last id it applied. The API keeps a **cursor per
  node** (`session_disconnect_cursors`), so a node that was down for any length
  of time applies everything it missed when its loop starts again. A node seen
  for the first time starts at the latest request (it has no older sessions).
  Requests are pruned after 30 days.
- With a Cyrus Murder, the loop runs on every frontend and backend, each with
  its own cursor.
- It uses the mail-login secret the Cyrus containers already have, so no
  installation needs a new secret.


## P1. External identities

### Data model

```
external_identities
  id               uuid pk
  organization_id  text  → organization (cascade)
  user_id          text  → user (cascade)
  issuer           text   -- an IdP issuer URL, or any stable string an app uses
  subject          text   -- the IdP "sub" / NameID, or the app's own user id
  label            text   -- shown in the admin ("Shop admin account")
  created_by       text
  created_at       timestamptz
  unique (organization_id, issuer, subject)
  index (user_id)
```

An identity belongs to the organization: the same `(issuer, subject)` can exist
in two organizations without meaning anything across them.

### Rules

- Only users who own an active **person** mailbox of the organization can be
  linked. **Instance administrators can never be linked**, and a user who becomes
  an instance administrator stops resolving (checked at resolution time, not only
  when linking).
- **SSO:** `resolveSsoUser` first looks for `(provider.issuer, accountKey.accountId)`
  among the identities of the **provider's organization**. If found, the user is
  used whatever email the IdP sends. If not, the current email match applies
  unchanged.
- Changes are audited (`identity.linked`, `identity.unlinked`).

### API (organization owners and admins, `OrgAccessGuard`)

```
GET    /api/orgs/:orgId/identities?userId=…
POST   /api/orgs/:orgId/identities         { userId, issuer, subject, label? }
DELETE /api/orgs/:orgId/identities/:id
```

Also editable from the admin panel, on the member's or mailbox's page.

## P2. Shared mailboxes

### Model

A shared mailbox is a mailbox of `kind = 'shared'` with **no user account**
(`user_id` null). It has no password and no app passwords, and nobody can log in
as it: the login bridge only accepts mailboxes that have an owner account. It
receives mail, has its own quota, aliases and Sieve rules like any mailbox.

```
shared_mailbox_members
  mailbox_id  uuid → mailboxes (cascade)        -- the shared mailbox
  user_id     text → user (cascade)             -- a person of the same organization
  rights      text check in ('read','readWrite','send')
  created_at, updated_at
  primary key (mailbox_id, user_id)
```

Members must own an active person mailbox in the **same organization**: Cyrus
identifies them by that address.

### Rights

Three levels, each including the previous one. This is the smallest set that
covers the real cases (someone who only watches, someone who works the queue,
someone who answers as the team) without exposing Cyrus' 13 ACL letters.

| Level | Can | Cyrus ACL (all folders of the shared mailbox) |
|---|---|---|
| `read` | see folders and messages | `lr` (`lrs` without shared seen state) |
| `readWrite` | also mark read/unread, flag, move, file, delete, and save drafts | `lrswitedn` |
| `send` | also send as the shared address | `lrswitedn` (sending is decided by Postarix) |

Members cannot create, rename or delete folders (no `k`, `x`), nor change ACLs
(no `a`): folders are managed by administrators (admin panel or API).

**Seen state.** A shared mailbox has one read/unread state for the whole team
(Cyrus' `sharedseen` mailbox annotation), **on by default** for shared
mailboxes: when someone handles a message, it is read for everyone. A
per-mailbox option turns it off, and then each member keeps their own state.
With the shared state on, `read` members get no `s`, so only people who work
the mailbox change it; with it off they get `s` for their own state.

### Source of truth and reconciliation

PostgreSQL holds members and rights. New `MailEngine` methods apply them:

```ts
/** Who may use a mailbox other than its owner, with what rights (all its folders). */
listMailboxAccess(address: string): Promise<MailboxAccess[]>;
/** Replaces who may use a mailbox; returns what changed. */
setMailboxAccess(address: string, access: MailboxAccess[]): Promise<void>;

type MailboxAccessLevel = 'read' | 'readWrite';
interface MailboxAccess { grantee: string; level: MailboxAccessLevel }
```

Implemented in `cyrus-engine` (GETACL/SETACL/DELETEACL on every folder of the
user, new folders included), `memory-engine` and `murder-engine` (on the
backend that holds the mailbox). After each change the API sets the ACLs, then
asks P0 to end the sessions of anyone who lost rights. A reconciliation job
(BullMQ, hourly, and on demand from the admin) compares every shared mailbox's
ACLs (and the `sharedseen` annotation) with PostgreSQL and fixes Cyrus, logging
what it changed. Folders administrators add later are covered by the same job
(and set at once when added through Postarix).

### JMAP

The proxy stops passing whatever accounts Cyrus lists. For each request it
computes the accounts the user may reach: their own, plus the shared mailboxes
they are a member of (from PostgreSQL). The rewritten session lists only those,
with `isReadOnly` true for `read` members, and any method call or upload or
download naming another `accountId` is refused with 403. Calendars and address
books shared by colleagues are not affected: they are reached through the
personal account's calendar capability, not a mail account.

### IMAP

Nothing to add: members see the shared mailbox under `Other Users/<name>`
(probed with the Thunderbird-equivalent client), within their rights.

### Sending from a shared mailbox

- The webmail (and P3 applications) save the draft **in the shared account**
  and call `/api/mail/send` with `{ emailId, accountId }`.
- The API checks that the person has `send` on that shared mailbox, that From is
  the shared address (or one of its aliases), sends it through the internal
  submission port and moves the message to **the shared mailbox's Sent**.
- `/api/mail/identities` lists, besides the person's own addresses, the shared
  mailboxes they have `send` on (with the shared mailbox's display name and its
  JMAP account id).
- `mail.sender_logins` gains the members with `send`, so Thunderbird can also
  send as the shared address over SMTP with the person's own credentials.
- **Who sent it**, as decided: always recorded in the audit log
  (`mail.sent_as_shared`: person, shared mailbox, Message-ID, recipients count).
  A per-organization setting, **off by default**, adds a `Sender:` header with
  the person (`Sender: Ana <ana@…>`), which most clients show as "Ana on behalf
  of Support". Sending over SMTP (Thunderbird) is audited from the Postfix log
  but gets no `Sender:` header.
- **Rate limits** are taken from **both** the person and the shared mailbox: the
  person's limit stops one compromised account from using every shared mailbox
  it belongs to, and the shared mailbox's limit caps the team as a whole.

### Removing access

Removing a member, lowering their rights, disabling their mailbox or deleting
their account: ACLs are removed at once (JMAP and new IMAP commands lose the
mailbox), and P0 ends their open IMAP sessions.

### Admin panel and webmail

- Admin → Mailboxes: "New shared mailbox" (no password fields), a Members tab
  (add a person, choose the level, remove), and the shared mailboxes listed with
  their own badge.
- API (organization owners and admins, or an API key limited to the
  organization), documented in the public docs:

  ```
  POST   /api/orgs/:orgId/mailboxes                { kind: "shared", domainId, localPart, displayName?, quotaBytes?, sharedSeen? }
  PATCH  /api/orgs/:orgId/mailboxes/:id            { sharedSeen?, displayName?, quotaBytes?, status? }
  GET    /api/orgs/:orgId/mailboxes/:id/members
  PUT    /api/orgs/:orgId/mailboxes/:id/members/:userId   { rights: "read" | "readWrite" | "send" }
  DELETE /api/orgs/:orgId/mailboxes/:id/members/:userId
  POST   /api/orgs/:orgId/mailboxes/:id/access/reconcile
  GET    /api/orgs/:orgId/mail-options
  PUT    /api/orgs/:orgId/mail-options                    { sharedSenderHeader }
  ```
- `/api/mail/messages/:id` takes `?accountId=` (a shared mailbox the person may
  read); the webmail's download and upload URLs carry the account, and the
  proxy refuses accounts the person cannot reach.
- Webmail: shared mailboxes appear in the sidebar under the personal folders
  with their folders and unread counts; the composer's From offers them when the
  person has `send`; read-only members see no write actions.

## P3. Connected applications

### Registration

```
connected_apps
  id               uuid pk
  organization_id  text → organization (cascade)   -- one organization only
  name             text
  client_id        text unique                      -- "pxapp_…"
  secret_hash      text null                        -- SHA-256 of a 256-bit secret
  jwks_uri         text null                        -- private_key_jwt (RFC 7523)
  jwks             jsonb null                       -- or the keys themselves
  identity_issuer  text                             -- which external identities it may name
  allow_user_id_subjects boolean default false      -- also accept Postarix user ids as subjects
  require_private_key_jwt boolean default false     -- refuse client secrets
  scopes           text[]                           -- mail.read, mail.write, mail.send, mail.supervise
  allowed_ips      cidr[] null
  expires_at       timestamptz null
  revoked_at       timestamptz null
  created_by, created_at, last_used_at
```

`jwks_uri` must be `https`; it is fetched only from public addresses (checked
again after DNS resolution, no redirects, 64 KB at most, like SSO issuers), and
cached for 10 minutes (refetched at once, at most once a minute, when a key id is
unknown).

Organization owners (or instance administrators) register them under
`/api/orgs/:orgId/apps` and in the admin panel. The secret is shown once.
Revoking takes effect on the next request (see tokens below).

### Scopes

| Scope | Allows |
|---|---|
| `mail.read` | JMAP read methods (`*/get`, `*/query`, `*/changes`, `SearchSnippet/get`), downloads, `/api/mail/messages/:id`, `/api/mail/image`, `/api/mail/identities`, unread counts |
| `mail.write` | also `Mailbox/set`, `Email/set`, `Email/copy`, `Email/import`, uploads |
| `mail.send` | also `/api/mail/send` |
| `mail.supervise` | read-only access to someone else's mailbox, see Supervision |

Calendar and contacts methods are not included in this first version.

### Token endpoint (public contract)

`POST /api/oauth/token`, **OAuth 2.0 Token Exchange (RFC 8693)**. The client
authenticates with `client_secret_basic` or `private_key_jwt` (RFC 7523,
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
assertions single-use within their 60 s lifetime, `jti` remembered in Valkey).

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<the user>
subject_token_type=urn:postarix:params:oauth:token-type:external-subject   (value = the app's subject)
scope=mail.read mail.send
```

The subject is not a signed token: the client is already authenticated, and the
subject can only be a user of its own organization. Postarix checks, in order:

- the client: exists, not revoked, not expired, request from an allowed IP;
- the scopes: a subset of the app's;
- the subject: an external identity with the app's `identity_issuer` in the
  app's organization, so an app only reaches people linked to it explicitly
  (P1). Apps with `allow_user_id_subjects` (off by default) may also name a user
  id (`urn:postarix:params:oauth:token-type:user-id`) of their organization; whose user owns an active person
  mailbox in an active domain, is not banned, and is **not an instance
  administrator**.

Answer (RFC 8693 §2.2):

```json
{ "access_token": "pxt_…", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer", "expires_in": 300, "scope": "mail.read mail.send" }
```

**The application never names mailboxes or addresses.** The token acts as that
user; the mailboxes it reaches are their own and their shared ones (P2).

### Access tokens

Opaque (`pxt_` + 256 random bits). Valkey keeps `sha256(token) → {app, user,
scopes, actor?, grant?}` for 5 minutes, and a set per app so revoking an app
deletes its tokens. Every request also checks the app (revoked, expired, IP)
from a 5-second cache, and the user's mailbox (as the cookie path does today).
So revocation, expiry, a disabled mailbox or a banned user stop a token within
seconds at most, and P0 covers IMAP.

### Routes that accept the token

`Authorization: Bearer pxt_…` is accepted, besides the session cookie, on:

```
/api/jmap/*                 (same method allow-list, filtered by scope)
POST /api/mail/send         (mail.send)
GET  /api/mail/identities   (mail.read)
GET  /api/mail/messages/:id (mail.read; the server-side sanitized rendering)
GET  /api/mail/image        (mail.read; the image proxy)
POST /api/mail/unread       (mail.read; see below)
```

With a bearer token there is no origin check (no cookie, so no CSRF), and the
session cookie is ignored. Each app has request limits (per app and per user,
in Valkey; 429 with `Retry-After`).

### Unread counts

`POST /api/mail/unread` with an **app-level** token (from the same endpoint with
`grant_type=client_credentials`, scope `mail.read`; it reaches nothing but this
route) and up to 200 subjects returns,
per subject, the unread count of the inbox and of each shared mailbox they can
read. Subjects are external subjects with the app's `identity_issuer` only;
any other is reported as unknown, never resolved. The API reads them through the admin connection (`STATUS (UNSEEN)`),
cached for 30 s. One request for a whole menu is cheaper and simpler for the
application than a JMAP EventSource held open per user (which would need a
token refreshed every 5 minutes per user). Applications that show one open
mailbox can still use JMAP `/changes` or the EventSource for live updates.

With the shared seen state (the default), a shared mailbox's count is the
team's; with it off, it is that person's.

### Supervision

An administrator of the organization reading an employee's mailbox through the
application.

- Allowed only when the organization turns it on (**off by default**), and only
  for apps with `mail.supervise`.
- The exchange names the employee as subject **and** the operator as actor
  (`actor_token`, same token type) **and** a `reason` (5–500 characters). The
  actor must be a person the organization granted the **"may supervise"**
  permission: a right of its own (`organization_supervisors`: organization,
  user, granted by, when), given by owners and admins in the admin panel or the
  API, that gives no access to the admin panel. Being an owner or admin does not
  include it.
- Never for instance administrators, nor for an operator acting on themselves.
- **Always read-only**: only `*/get`, `*/query`, `*/changes`, `SearchSnippet/get`,
  downloads and `/api/mail/messages/:id`. No flags, no moving, no sending.
- **Read state untouched:** nothing a supervisor does changes `\Seen` (or any
  flag). JMAP reads never set it; `/api/mail/messages/:id` and downloads go
  through JMAP `Email/get` and blob downloads, never IMAP `FETCH BODY[]`. Tests
  check that a message's keywords are the same before and after supervision.
- **Only the employee's personal mailbox:** the session lists only their own
  account; their shared mailboxes are not reachable under supervision.
- Limited duration: the exchange opens a **supervision grant** of up to 60
  minutes (`supervision_grants` table: app, operator, employee, reason,
  expires_at). Tokens last 5 minutes and need a valid grant to be renewed.
- Audited in the organization and the instance (`mailbox.supervision_started`,
  `mailbox.supervision_ended`), and every request made under it is logged
  (`supervision_access`: method names, mailbox, time; never content).
- **Notifying the employee**: an organization setting, **off by default**; when
  on, the employee gets a plain message (who, when, the reason).
- The same limits as "Sign in as": never instance administrators.

### Audit

`app.token_issued` (app, user, scopes; one entry per user per hour, not per
token), `app.created`, `app.revoked`, `app.secret_rotated`, supervision as above.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| A stolen app secret | IP allow-list, expiry, immediate revocation, `private_key_jwt` recommended, tokens last 5 minutes, request limits, audit of every issuance |
| An app reaching another organization | Apps belong to one organization; subjects must be users of it; every lookup scoped by organization; isolation tests |
| An app reaching instance administrators | Refused at exchange and at link time, re-checked at every resolution |
| An app choosing which mailbox | It cannot: tokens act as a user; Postarix and Cyrus ACLs decide |
| Removed members keeping access | ACLs removed at once, JMAP accounts filtered per request, P0 ends IMAP sessions |
| Tokens leaking to browsers | Documented server-side only; no CORS on these routes; tokens are useless after 5 minutes |
| Abuse of supervision | Off by default, owner/admin actor only, reason required, read-only, time-limited, audited per request, optional notice |
| Spoofing a shared address | Sending checks membership with `send`; Rspamd keeps From = envelope; `sender_logins` derived from PostgreSQL |
| Tokens skipping the organization's second-factor rule | By design: an app token is not a sign-in. The app is responsible for how its own users sign in; documented for integrators |
| Replay of client assertions | `jti` remembered for their lifetime; 60 s maximum |

## For integrators (the order to set things up)

1. Instance admin: create the **organization** and add and verify its **domain**.
2. Create an **API key** limited to that organization, to provision people,
   mailboxes and shared mailboxes from the application if wanted.
3. Create the **person mailboxes**, the **shared mailboxes** and their **members**.
4. Register the **connected application** (scopes, IP allow-list, `identity_issuer`).
5. Link each person to the application's user id as an **external identity**
   (with that issuer), from the admin panel or with the API key.
6. In the application's server: exchange for a token per user when needed, call
   JMAP and `/api/mail/*` with it, never send it to the browser.

App tokens do **not** go through the organization's second-factor rule: the
organization trusts the application to have signed its user in properly
(ideally with its own second factor). Register only applications you trust
with that.
