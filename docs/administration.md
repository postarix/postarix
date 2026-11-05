# Domains, mailboxes and aliases

What each setting in the admin panel does. Organization administrators manage
their own domains, mailboxes and aliases; a few limits are reserved for
**instance administrators** (the people who run the server and host the
organizations).

The admin panel and the webmail are in English and Spanish: each person
chooses in the sidebar (admin panel) or their menu (webmail); the first visit
follows the browser's language.

## Domains

The gear button of a domain opens its settings.

| Setting | Who | Meaning |
|---|---|---|
| Description | organization admins | A note for administrators. |
| Default mailbox quota | organization admins | Quota of new mailboxes when none is chosen. Empty: unlimited. |
| Enabled | organization admins | A disabled domain receives and sends no mail, and its mailboxes cannot sign in (web or mail apps); everyone signed in is signed out. Its mail and settings are kept. |
| Mailboxes, aliases | instance admins | How many the domain may have. |
| Largest quota per mailbox | instance admins | No mailbox may get more; with it set, no mailbox can be unlimited. |
| Total quota | instance admins | The quotas of all the domain's mailboxes together. |
| Sending limit per mailbox | organization admins | Messages each of its mailboxes may send per second, minute, hour or day, unless the mailbox has its own limit. |

Limits cannot be set below what the domain already has (lower a mailbox's
quota, or delete mailboxes, first). The domain card shows the usage against
the limits.

### MTA-STS

Each domain publishes an MTA-STS policy (the `mta-sts` records in its DNS
list), telling other servers whether they must deliver to it over verified
TLS: **enforce** (refuse otherwise), **testing** (deliver anyway, report
failures) or **none** (the policy is withdrawn). The domain settings choose
the mode; by default it is the server's (`MTA_STS_MODE`, `testing` unless
set). Changing it changes the `_mta-sts` id, so other servers fetch the policy
again.

### Backup MX

Instance administrators can make a domain a **backup MX** in its settings:
its mail is hosted on another server, and this one only accepts it while that
server cannot be reached, then hands it over (to the **primary server** given,
or else to the domain's most preferred MX). Every address of the domain is
accepted (the primary server knows its recipients), the spam filter still
applies, and the domain has no mailboxes, aliases or alias domains here. Its
DNS list only has an MX record, with a lower preference (20) than the primary
server's.

### DKIM key

The key button of a domain shows its DKIM signing key: the selector, the size
and the DNS record to publish. **Replace key** generates a new one (1024 to
4096 bits, 2048 by default) or imports the private key the domain already
uses elsewhere (an RSA key in PEM format, e.g. from mailcow), so you can move
without changing DNS. The new key signs mail at once: publish its record
first, or use a new selector and publish its record before replacing.

### Alias domains

When you add a domain you can make it an **alias of** another domain of the
organization: every address of that domain then exists on the alias domain
too. Mail to `ann@example.org` reaches `ann@example.com`, and Ann may send as
`ann@example.org` (and as the aliases she may use, on both domains). An alias
domain is verified like any other (it gets its own DKIM key and DNS records)
and has no mailboxes or aliases of its own. Disabling it stops only the alias
domain.

## Mailboxes

Besides the name, quota and password, a mailbox has:

- **Status.** *Active*; *Receives mail, nobody can sign in* (for a shared
  address read through other means, or an account on hold); or *Disabled*
  (no sign-in and no mail: senders get an error). Leaving *Active* signs
  everyone out of it, mail apps included: connections already open (IMAP,
  POP3, Sieve) are closed within seconds, not only new sign-ins refused. The
  same happens when its password changes, an app password is revoked, a
  second factor or passkey is added, or the account is banned or deleted.
- **Mail apps may use:** IMAP, POP3, SMTP (sending), Sieve filters, and
  calendars and contacts (CalDAV/CardDAV). The protocols left out are refused
  for its password and its app passwords alike; the webmail always works.
- **Refuse incoming mail from servers that do not use TLS.** Other servers
  must encrypt the connection to deliver to it (they get a permanent error
  otherwise).
- **Send outgoing mail only over TLS.** Its mail is only handed to servers
  that accept TLS; if a server does not, the message waits and is eventually
  returned to the sender.
- **Sending limit:** messages it may send per second, minute, hour or day,
  from mail apps and the webmail together. Over the limit, mail apps get a
  temporary error (they try again later) and the webmail says so. Without
  one, the domain's limit applies.
- **Can also send as:** further addresses it may use as sender, one per line,
  or `@example.com` for every address of a domain. Only the organization's
  own domains. A mailbox can always send as itself and as the aliases that
  deliver to it.

### Templates

The **Templates** button of the mailboxes page keeps the organization's
mailbox templates: quota, allowed protocols, TLS requirements, sending limit,
spam scores and quarantine notices. New mailboxes start with the template
chosen when creating them (the default one is preselected; **None** for no
template); what is typed in the form wins over the template. Instance
administrators keep domain templates in **Administration → Templates**: limits,
default quota, sending limit, spam scores and MTA-STS mode. The default domain
template applies to every domain an organization adds, so new domains start
with the instance's limits. Changing or deleting a template does not change
what was already made with it.

### Shared mailboxes

A **shared mailbox** (type *Shared mailbox* when creating it) is a team's
address, like `support@` or `sales@`. It receives mail and has its own quota,
aliases and filters, but no account: nobody signs in as it, so it has no
password. Its **members** (the people button) use it from their own mail:

| Members can | In the webmail and mail apps |
|---|---|
| **Read** | See its folders and messages |
| **Read and organize** | Also mark read or unread, flag, move, file, delete, save drafts |
| **Read, organize and send** | Also send as the shared address |

- Members must have their own mailbox in the organization. In the webmail the
  shared mailbox appears below their folders; in IMAP apps, under
  **Other Users**.
- **One read/unread state for the whole team** (on by default): when someone
  handles a message, it is read for everyone. Off, each member keeps their own.
  People who can only read never change it.
- Folders are managed by administrators; members cannot create or delete
  them.
- Mail sent from it goes out as the shared address and is filed in **its**
  Sent folder. Who sent it is always recorded in **Activity**; the
  **Shared mailboxes** option on this page can also add a `Sender:` header with
  the person (most apps then show "Ana on behalf of Support"). Mail apps can
  send as it too, with the person's own login (no `Sender:` header then).
  Sending limits apply to the person and to the shared mailbox.
- Removing a member, giving them less, disabling the shared mailbox or the
  member's own mailbox takes effect at once, including mail apps already
  connected. A member whose mailbox is deleted stops being one.
- Postarix keeps the members and checks every hour that the mail server
  agrees, fixing it if not.

With an API key limited to the organization:

```
POST   /api/orgs/<orgId>/mailboxes                      {"kind": "shared", "domainId": "…", "localPart": "support", "displayName": "Support", "sharedSeen": true}
PATCH  /api/orgs/<orgId>/mailboxes/<id>                 {"sharedSeen": false}
GET    /api/orgs/<orgId>/mailboxes/<id>/members
PUT    /api/orgs/<orgId>/mailboxes/<id>/members/<userId> {"rights": "read" | "readWrite" | "send"}
DELETE /api/orgs/<orgId>/mailboxes/<id>/members/<userId>
POST   /api/orgs/<orgId>/mailboxes/<id>/access/reconcile
GET    /api/orgs/<orgId>/mail-options
PUT    /api/orgs/<orgId>/mail-options                   {"sharedSenderHeader": true}
```

A person's `userId` is in the mailbox list (`GET /api/orgs/<orgId>/mailboxes`).

### Sync jobs

The **sync jobs** button of a mailbox copies mail from another IMAP server
into it, like imapsync: enter the server, the user name and the password of
the old account, and whether to run once or repeat (every 15 minutes, hour,
6 hours or day). Folders keep their names, special folders map to ours, flags
are kept, and every run copies only what is new. A repeating job keeps the
password encrypted until it is stopped or deleted; a one-time job erases it
when it ends. **Run now** starts a repeating job at once. Old servers on a
private network must be allowed first (see [Migration](MIGRATION.md)).

### Identities

The **identities** button of a person's mailbox (the fingerprint) links its
owner to who they are elsewhere: an `(issuer, subject)` pair, where the issuer
is an identity provider's issuer URL or the name an application uses for
itself, and the subject is the person's id there (an OpenID Connect `sub`, a
SAML NameID, an application's user id).

- **Single sign-on** first looks for the identity the provider asserts (its
  issuer and the person's `sub`) among the organization's identities, and signs
  in the person linked to it, whatever email the provider sends: useful when
  the provider knows people by another email. A linked person whose mailbox
  cannot sign in is refused. Unlinked people keep signing in by email, as
  before.
- **Connected applications** name the person they act for by an identity of
  their own issuer.
- A pair means something only inside its organization, and links one person.
  Only owners of person mailboxes can be linked, never an instance
  administrator. Linking and unlinking are recorded in **Activity**.
- With an API key limited to the organization:

  ```
  GET    /api/orgs/<orgId>/identities?userId=…&issuer=…
  POST   /api/orgs/<orgId>/identities   {"mailboxId": "…", "issuer": "…", "subject": "…", "label": "…"}
  DELETE /api/orgs/<orgId>/identities/<id>
  ```

  `userId` can be given instead of `mailboxId` (mailboxes list their owner's
  `userId`).

### Sign in as a mailbox

Instance administrators can open someone's mailbox in the webmail, as its
owner, with **Sign in as** (the arrow in the mailbox's row). It is meant for
legitimate needs: a colleague on leave, a departed employee's pending mail, a
support case the owner asked for.

- It needs two-step verification on the administrator's session, and a
  **reason**, which is kept in the organization's **Activity** with who, when
  and which mailbox (and when they left, with how long they stayed): the
  organization's own administrators see it.
- The session lasts at most an hour. A banner says whose mailbox it is, with
  **Leave** to go back to your own session. Inside, only the mailbox's mail,
  calendar, contacts and settings are open: no administration, and nothing
  about the account's security (password, app passwords, two-step
  verification, passkeys).
- Another instance administrator's mailbox cannot be entered this way.
- **Settings → Sign in as a mailbox** lets each organization's owners and
  admins do the same in their organization's mailboxes (off by default).

::: warning The law, not the software, decides when this is allowed
In many countries reading an employee's mail requires a legitimate reason,
proportionality and, often, having told people beforehand in a written policy
(in the European Union, under the GDPR and national labour law). Postarix
records every access but cannot judge whether it was allowed: write your
policy, tell people, and keep the reasons meaningful.
:::

## Aliases

- An alias forwards to one or more addresses, inside or outside the server.
- A **catch-all** (`@example.com`) receives the mail for every address of the
  domain that is not a mailbox or another alias. Use it sparingly: it also
  collects spam sent to made-up addresses.
- **Accept mail and silently drop it** takes the mail and throws it away,
  for an old address that only gets spam, without telling the sender.
- **Temporary addresses:** people make throwaway addresses for themselves in
  the webmail (their menu → Temporary addresses), for a shop or a
  newsletter: an alias of their domain that delivers to them for an hour to
  a year, then stops working and is deleted. They appear in the aliases list
  with their expiry, and count against the domain's alias limit.
- Spam for an alias goes to the Junk folder of its destinations on this
  server, and is never forwarded outside.

## Copies (BCC)

The **Copies (BCC)** page sends a blind copy of the mail an address, or every
address of a domain (`@example.com`), receives or sends to another address,
here or elsewhere: a manager, a compliance mailbox, a CRM. Senders and
recipients do not see the copy. Rules apply to the domain's alias domains too,
and add to the archive's copies (see [Archiving](ARCHIVING.md)). A rule can be
disabled for a while without deleting it.

## Spam filter

Every incoming message gets a spam score. From the **junk** score (6 by
default) it is filed in the recipient's Junk folder; from the **refuse** score
(15 by default) it is refused. The shield button of a domain or a mailbox sets
both, and lists senders:

- **Block:** mail from them is refused.
- **Allow:** mail from them skips the spam filter, as long as their server
  proves who they are (SPF for the envelope sender, or DMARC for the From
  address): anyone can write any address in a From line.

A sender is an address, `@example.com`, or `@.example.com` for its
subdomains. A mailbox's settings come first, then its domain's, then the
server's. People can change their own in the webmail (their menu → Spam
filter). Instance administrators keep a list for every mailbox on the server
in **Mail policy → Spam filter**. A message sent to several people at once is
judged by the first recipient's settings.

### Quarantine

Spam that is refused (not viruses, not blocked senders) is kept for its
recipients for 30 days (`QUARANTINE_RETENTION_DAYS`), up to 10 MB per
message (`QUARANTINE_MAX_BYTES`); instance administrators change both, and
the rest of its behaviour, in **Mail policy → Quarantine**. The sender is still told it was refused.
People see theirs in the webmail (their menu → Quarantine) and release a
message to their inbox, or delete it; they get a digest of new items daily
by default (never, hourly, daily or weekly: in the webmail or the mailbox's
settings). Organization admins see their mailboxes' items in the
**Quarantine** page, and can release, download or delete them.

## Server, mail policy and administration (instance administrators)

The sidebar has the organization in view (switch with the box at the top),
its sections, the sections for instance administrators (in three groups:
**Server**, **Mail policy** and **Administration**) and the **Apps**: the
webmail, Rspamd's own web interface and any links set in **Customize**. The
**Dashboard** (the first entry) sums the server up: organizations, domains,
mailboxes, aliases, quarantine and queue, the mail of the last 24 hours per
hour, the services' state and disk use, and the largest organizations.

**Server:**

- **Services:** whether the API, PostgreSQL, Valkey, Rspamd, Postfix, Cyrus,
  Unbound (and ClamAV, CrowdSec when they run) answer, their versions and
  disk use, with a link to each one's log.
- **Logs:** the latest lines of every service: the API, Postfix, Cyrus,
  Rspamd, Unbound, ClamAV, CrowdSec and the certificates. Each line shows its
  time, level (errors and warnings stand out), process and message. Search
  as you type (an address, a queue ID, an IP address…) across a service's
  last 5000 lines, keep only warnings or errors, follow it live, or download
  it. The containers send their logs to the API's internal listener every 15
  seconds with the reports secret (`POSTARIX_SECRET_REPORTS`, set by
  `derive-secrets.sh`); their own output (`docker compose logs`) is
  unchanged.
- **Spam filter history:** every message Rspamd checked on the server: what
  it decided (delivered, junk, greylisted, refused), its score and the rules
  behind it, with a chart of the last 24 hours and Rspamd's statistics.
  Organizations see their own part in their **Mail log**.
- **Rspamd web interface** (under Apps): Rspamd's own interface, opened with
  your administrator session (no separate password). It can only read unless
  `RSPAMD_CONTROLLER_ENABLE_PASSWORD` is set; with it, it can also learn
  spam and ham and change Rspamd's settings.
- **Mail queue:** the messages waiting to be delivered and why. Select
  messages to deliver them now, hold them, release them or delete them, or
  retry or delete the whole queue.

**Mail policy:**

- **Outgoing routing:**
  - *Smart hosts*: services (SendGrid, Amazon SES, your provider's relay…)
    with their login. Choose one for a domain in its settings (every mailbox
    of the domain) or for a single mailbox in its settings; only instance
    administrators can.
  - *Routes*: hand mail for a destination (a domain, `.domain` for its
    subdomains, or an address) to a given server instead of its MX; not for
    domains hosted here.
  - *Recipient rewrites*: mail for an address, here or anywhere else (a
    partner's old address, a former colleague's), or for every address of a
    domain (`@old.example`), is delivered to another address instead, whoever
    sends it. A rewrite wins over mailboxes and aliases; it cannot point to an
    address that is rewritten itself.
  - *TLS policies*: how strictly mail to a destination must be encrypted
    (`encrypt`, `dane-only`, `secure` with `match=`…, or `none`), in
    Postfix' terms.

  Postfix reads routing from the database: changes apply within seconds.
  Passwords are never shown again; Postfix needs them in clear, so they are
  stored as given (readable by the API and Postfix' database accounts only).

- **Spam filter:** senders blocked or allowed for every mailbox (see above).
- **Content filters:** regular expressions on the subject, the sender (its
  address and name), the recipients or any header of incoming mail, matched
  without regard to case. Matching mail is refused, or filed as junk. Mail
  your own people send (signed in) is never checked.
- **Forwarding hosts:** servers that forward mail here (say, another
  provider where someone keeps a forwarding rule), as an address, a network
  or a host name (looked up again every 10 minutes). Their mail is never
  greylisted, refused as spam or checked against DNS blocklists;
  with *Do not scan* it is not scanned at all.
- **IP access:** networks *blocked* (refused by Postfix when they connect to
  send mail, and by the API: the panel, the webmail, JMAP) or *allowed*
  (Postfix's client checks let them through; the spam filter and sign-in
  still apply). A block wins; you cannot block the address you are using.
  Below, the accounts with recent wrong passwords (web or mail apps): locked
  ones can be unlocked at once.
- **Quarantine:** how long refused spam is kept (empty:
  `QUARANTINE_RETENTION_DAYS`), the largest message kept, domains whose
  refused mail is never kept, a spam score above which nobody is told
  (obvious spam), the notices' sender and subject, an address that gets every
  notice instead of the recipients (a help desk) or a blind copy of them, and
  whether released mail arrives as it was or attached to a short note.
- **DKIM keys:** every domain's signing key (selector, size, date) and
  whether DNS publishes it: *Published*, *Not in DNS* or *Another key in
  DNS*. *Use another domain's key* gives a domain a copy of another's key and
  selector, so both share one DNS record.

**Administration:**

- **Administrators:** the instance administrators, whether they use
  two-step verification, and adding one: an existing account (someone's
  mailbox) gets the rights, or a new account is created with a name and a
  password. Removing the rights keeps the account and signs it out; you
  cannot remove your own, nor the last administrator.
- **Mail to everyone:** a plain-text message from the server to every active
  mailbox, or to those of some organizations, except chosen addresses. The
  number of recipients is shown before sending; each mailbox gets its own
  copy, sent in the background.
- **Templates:** domain and mailbox templates (see above).

- **API keys:** for scripts and other software (provisioning, monitoring).
  They call the same API as the admin panel with
  `Authorization: Bearer px_…`, as the administrator who created the key:
  read-only keys can only read, and a key can be limited to some addresses
  or networks and given an expiry. A key can also be limited to some
  organizations: it then only reaches `/api/orgs/<id>/…` of those, as their
  owner (not as an instance administrator: no limits or smart hosts). The key is shown once; it stops working
  when deleted, when it expires, or when its creator is no longer an
  instance administrator.
- **Customize:** the name and logo (PNG, JPEG, WebP or SVG, up to 200 KB)
  shown in the panel, the webmail and the sign-in pages; a sign-in message
  and a footer; whether the sign-in pages offer only single sign-on and
  passkeys (the password form stays at `?password=1`); an announcement shown
  to everyone signed in, as information, important or urgent; the help page,
  and links to your other apps in the Apps menus.
- **Settings:**
  - *Sign-in protection:* how many wrong passwords (web or mail apps) lock
    an account, and for how long (10 and 15 minutes by default). App
    passwords are never locked.
  - *Passwords:* minimum length (12 or more) and whether to require a mix
    of lowercase, uppercase, digits and symbols.
  - *Mailbox quota notice:* at what percentage people are told by mail that
    their mailbox is filling up (90% by default; reminded weekly while it
    stays full), and the notice's sender, subject and text (`{address}`,
    `{percent}`, `{used}`, `{quota}`).

Postfix and Cyrus send their logs and the queue to the API every 15 seconds
(with `POSTARIX_SECRET_REPORTS`; see the [configuration](./configuration)), so
what you see is at most that old, and queue actions take effect within that
time. No container gets access to Docker for this.
