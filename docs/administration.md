# Domains, mailboxes and aliases

What each setting in the admin panel does. Organization administrators manage
their own domains, mailboxes and aliases; a few limits are reserved for
**instance administrators** (the people who run the server and host the
organizations).

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

## Aliases

- An alias forwards to one or more addresses, inside or outside the server.
- A **catch-all** (`@example.com`) receives the mail for every address of the
  domain that is not a mailbox or another alias. Use it sparingly: it also
  collects spam sent to made-up addresses.
- **Accept mail and silently drop it** takes the mail and throws it away,
  for an old address that only gets spam, without telling the sender.
- Spam for an alias goes to the Junk folder of its destinations on this
  server, and is never forwarded outside.

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

Postfix and Cyrus send their logs and the queue to the API every 15 seconds
(with `POSTARIX_SECRET_REPORTS`; see the [configuration](./configuration)), so
what you see is at most that old, and queue actions take effect within that
time. No container gets access to Docker for this.
