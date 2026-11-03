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
  everyone out of it.
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

### Sync jobs

The **sync jobs** button of a mailbox copies mail from another IMAP server
into it, like imapsync: enter the server, the user name and the password of
the old account, and whether to run once or repeat (every 15 minutes, hour,
6 hours or day). Folders keep their names, special folders map to ours, flags
are kept, and every run copies only what is new. A repeating job keeps the
password encrypted until it is stopped or deleted; a one-time job erases it
when it ends. **Run now** starts a repeating job at once. Old servers on a
private network must be allowed first (see [Migration](MIGRATION.md)).

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
in **System → Spam filter**. A message sent to several people at once is
judged by the first recipient's settings.

### Quarantine

Spam that is refused (not viruses, not blocked senders) is kept for its
recipients for 30 days (`QUARANTINE_RETENTION_DAYS`), up to 10 MB per
message (`QUARANTINE_MAX_BYTES`). The sender is still told it was refused.
People see theirs in the webmail (their menu → Quarantine) and release a
message to their inbox, or delete it; they get a digest of new items daily
by default (never, hourly, daily or weekly: in the webmail or the mailbox's
settings). Organization admins see their mailboxes' items in the
**Quarantine** tab, and can release, download or delete them.

## System (instance administrators)

**System**, in the sidebar, shows the server itself:

- **Services:** whether the API, PostgreSQL, Valkey, Rspamd, Postfix and
  Cyrus are running, their versions and the disk use of the mail store and
  the mail queue.
- **Logs:** the last few thousand lines of Postfix' and Cyrus' logs, with a
  filter (an address, a queue ID, an IP address…). The spam filter's
  decisions are in each organization's **Mail log**.
- **Mail queue:** the messages waiting to be delivered and why. Select
  messages to deliver them now, hold them, release them or delete them, or
  retry or delete the whole queue.

- **Outgoing routing:**
  - *Smart hosts*: services (SendGrid, Amazon SES, your provider's relay…)
    with their login. Choose one for a domain in its settings (every mailbox
    of the domain) or for a single mailbox in its settings; only instance
    administrators can.
  - *Routes*: hand mail for a destination (a domain, `.domain` for its
    subdomains, or an address) to a given server instead of its MX; not for
    domains hosted here.
  - *TLS policies*: how strictly mail to a destination must be encrypted
    (`encrypt`, `dane-only`, `secure` with `match=`…, or `none`), in
    Postfix' terms.

  Postfix reads routing from the database: changes apply within seconds.
  Passwords are never shown again; Postfix needs them in clear, so they are
  stored as given (readable by the API and Postfix' database accounts only).

- **API keys:** for scripts and other software (provisioning, monitoring).
  They call the same API as the admin panel with
  `Authorization: Bearer px_…`, as the administrator who created the key:
  read-only keys can only read, and a key can be limited to some addresses
  or networks and given an expiry. The key is shown once; it stops working
  when deleted, when it expires, or when its creator is no longer an
  instance administrator.
- **Settings:**
  - *Sign-in protection:* how many wrong passwords (web or mail apps) lock
    an account, and for how long (10 and 15 minutes by default). App
    passwords are never locked.
  - *Passwords:* minimum length (12 or more) and whether to require a mix
    of lowercase, uppercase, digits and symbols.
  - *Mailbox quota:* at what percentage people are told by mail that their
    mailbox is filling up (90% by default; reminded weekly while it stays
    full).
  - *Branding:* the name on the sign-in pages, a sign-in message (e.g. who
    to call for help), an announcement shown to everyone signed in, and a
    help page.

Postfix and Cyrus send their logs and the queue to the API every 15 seconds
(with `POSTARIX_SECRET_REPORTS`; see the [configuration](./configuration)), so
what you see is at most that old, and queue actions take effect within that
time. No container gets access to Docker for this.
