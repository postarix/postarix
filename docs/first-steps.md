# First steps

Once Postarix is running and you have signed in at
`https://mail.example.com/admin` with the administrator account:

## 1. Protect your account

Open **Account** and set up two-step sign-in (an authenticator app) or a
passkey. Your administrator account can read every organization's settings:
it deserves the strongest protection.

## 2. Create an organization

An organization is a company, a family, a customer: it owns domains,
mailboxes and aliases, and its members only ever see its own data. Create one
from the organization menu.

## 3. Add your domain

In **Domains**, add `example.com`. Postarix shows a TXT record that proves the
domain is yours: publish it at your DNS provider and press **Verify** (DNS
changes can take a few minutes to be visible).

Once verified, the domain page lists every record to publish, with its exact
value and a live check:

| Record | Why |
|---|---|
| **MX** → `mail.example.com` | Other servers deliver your mail here. |
| **SPF** (TXT) | Says which servers may send for your domain. |
| **DKIM** (TXT) | The public key that proves your messages are genuine. |
| **DMARC** (TXT) | Tells receivers what to do with mail that fails SPF and DKIM. |
| **MTA-STS** (a CNAME and a TXT) | Asks other servers to always use encrypted connections to you. |
| **autoconfig** (CNAME) | Lets Thunderbird and other mail apps set themselves up from an address. |

::: tip Moving an existing domain?
Do not change the MX record yet: follow [Moving from another
provider](./migration) so no mail is lost.
:::

## 4. Create mailboxes

In **Mailboxes**, create one per person (or shared address), with a password
of at least 12 characters and an optional quota. People sign in to the
webmail at `https://mail.example.com` with their address and that password.

- **Aliases** forward an address to one or more mailboxes (or outside
  addresses): `info@`, `sales@`…
- A mailbox of type **Room** or **Equipment** can be booked from the calendar
  (see [Calendar](./calendar)).
- **Members** gives people roles in the organization: *owner*, *admin* (manages
  mailboxes and domains) or *member*.

## 5. Mail apps and phones

People can use the webmail, or any mail app over IMAP and SMTP, and sync
calendars and contacts over CalDAV and CardDAV. Each device should use an
**app password** (webmail menu → Security and app passwords). Details per app
in [Connecting devices](./connecting-devices).

## 6. Recommended settings

- **Sign-in** page: require two-step sign-in for the whole organization, or
  connect your identity provider (Microsoft Entra ID, Google Workspace, Okta,
  Keycloak… over OpenID Connect or SAML).
- **Mailboxes → Archiving and legal hold**, if you must keep mail
  ([Archiving](./archiving)).
- Check that backups run ([Backups](./backup)) and that someone gets the
  alerts ([Monitoring](./monitoring)).
