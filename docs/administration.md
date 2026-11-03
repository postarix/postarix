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

Limits cannot be set below what the domain already has (lower a mailbox's
quota, or delete mailboxes, first). The domain card shows the usage against
the limits.

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
