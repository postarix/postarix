# Integrating another application

Another application (a helpdesk, a CRM, a company intranet…) can be the mail
client of your people: it shows them their mailbox and the shared mailboxes
they belong to, and sends as them, inside its own interface. Postarix stays
the mail server: it decides which mailboxes each person reaches and what they
may do there, and the mail server enforces it.

The application never gets a password, and never chooses a mailbox. It asks
Postarix for a **short token that acts as one person** (OAuth 2.0 Token
Exchange, [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)), and uses it
with JMAP ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620),
[RFC 8621](https://www.rfc-editor.org/rfc/rfc8621)) and a few `/api/mail`
routes. Postarix sanitizes message HTML and proxies remote images for it.

## What to set up, in order

1. **Organization and domain.** Create the organization, add its domain and
   verify it (instance administrators).
2. **An API key limited to the organization** (Administration → API keys), if
   the application should create people, mailboxes and shared mailboxes
   itself. It reaches only `/api/orgs/<orgId>/…` of that organization.
3. **People and shared mailboxes.** Each person gets a mailbox; shared
   mailboxes get members (see [Shared mailboxes](administration.md#shared-mailboxes)).
4. **The connected application** (Organization → Applications; owners): its
   name, its **identity issuer** (the name it uses for itself, for example
   `https://helpdesk.example.com`), what it may do (scopes), the addresses it
   calls from, an expiry, and how it proves who it is: a secret, or signed
   assertions (`private_key_jwt`) with its public keys.
5. **Link each person to the application**: the mailbox's **Identities**
   button, with the application's issuer and the person's id in the
   application. With the API key:

   ```
   POST /api/orgs/<orgId>/identities
   {"mailboxId": "…", "issuer": "https://helpdesk.example.com", "subject": "1234"}
   ```

The application only reaches people linked this way. An application may be
allowed to name people by their Postarix user id instead (off by default):
that skips the links, so only turn it on for an application that already
manages everything.

## Scopes

| Scope | Gives |
|---|---|
| `mail.read` | JMAP reading (`Mailbox/get`, `Email/query`, `Email/get`, `Thread/get`, `SearchSnippet/get`, `…/changes`), downloads, `GET /api/mail/messages/{id}`, `GET /api/mail/identities`, unread counts |
| `mail.write` | Also `Email/set`, `Mailbox/set`, `Email/copy`, `Email/import`, uploads: flag, move, delete, save drafts |
| `mail.send` | `POST /api/mail/send` (sending a draft needs `mail.write` to save it first) |
| `mail.supervise` | Supervision, see below |

Calendars and contacts are not available to applications.

## Getting a token

`POST https://<your server>/api/oauth/token`, as
`application/x-www-form-urlencoded`. With a secret (HTTP Basic, or
`client_id` and `client_secret` in the body):

```bash
curl -s https://mail.example.com/api/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token=1234 \
  -d subject_token_type=urn:postarix:params:oauth:token-type:external-subject \
  -d scope="mail.read mail.write mail.send"
```

```json
{
  "access_token": "pxt_…",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "mail.read mail.write mail.send"
}
```

`subject_token` is the person's id in the application (their external
identity with the application's issuer). Tokens last **5 minutes**: ask for a
new one when it expires, there is no refresh token.

With `private_key_jwt` ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523)),
instead of the secret send a signed assertion:

```
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion=<JWT>
```

The JWT has `iss` and `sub` = the client ID, `aud` =
`https://<your server>/api/oauth/token`, a unique `jti`, and an `exp` at most
60 seconds away; each assertion works once. It is signed with RS256, PS256,
ES256 (or their 384/512 variants) or EdDSA; Postarix checks it with the keys
pasted in the application, or fetched from its JWKS URL (https on a public
address, cached for 10 minutes and fetched again when a new key id appears).
Applications can be set to accept only this.

Errors follow RFC 6749: `{"error": "invalid_grant", "error_description": "…"}`
with status 400, or 401 for `invalid_client`.

## Using the token

Send it as `Authorization: Bearer pxt_…` from the application's **server**:

| Route | Use |
|---|---|
| `GET /api/jmap/` | The JMAP session: the person's own account and their shared mailboxes (`isReadOnly` where they, or the token, cannot change anything) |
| `POST /api/jmap/` | JMAP method calls (mail only) |
| `GET /api/jmap/download/{accountId}/{blobId}/{name}` | Attachments and raw messages (served with a sandboxing CSP) |
| `POST /api/jmap/upload/{accountId}/` | Uploads (attachments for drafts) |
| `GET /api/jmap/eventsource/` | Push of changes (JMAP EventSource) |
| `GET /api/mail/identities` | Who the person may send as: their addresses and the shared mailboxes they may send from (with each one's `accountId`) |
| `GET /api/mail/messages/{id}?accountId=…` | A message rendered for display: sanitized HTML, remote images replaced by links to Postarix' image proxy, attachments |
| `POST /api/mail/send` | `{"emailId": "…", "accountId": "…"}`: sends a draft saved in that account (omit `accountId` for the person's own) |

The JMAP account ids are mailbox addresses. To send from a shared mailbox,
save the draft in the shared mailbox's account and send with its
`accountId`: Postarix checks the person may send from it, files the copy in
that mailbox's Sent folder, and records who sent it.

Limits: 1200 requests a minute per application and 240 per person (then
`429`), 600 token requests a minute.

### Unread counts for a menu

One request for many people, with the application's **own** token:

```bash
curl -s https://mail.example.com/api/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials -d scope=mail.read
curl -s https://mail.example.com/api/mail/unread -H "Authorization: Bearer $APP_TOKEN" \
  -H 'content-type: application/json' -d '{"subjects": ["1234", "5678"]}'
```

```json
{ "data": [
  { "subject": "1234", "inbox": 3, "shared": [{ "address": "support@example.com", "name": "Support", "unread": 12 }] },
  { "subject": "5678", "inbox": null, "shared": [] }
] }
```

Up to 200 subjects per request, people linked to the application only
(`inbox: null` for anyone else). Counts are cached for 30 seconds: poll every
30 to 60 seconds. For the open mailbox, JMAP `…/changes` or the EventSource
with that person's token give live updates.

## Supervision

An organization can let some people read someone else's mailbox through the
application, for example a manager reviewing a complaint. It is **off by
default**, and:

- The organization turns it on (Applications → Supervision) and chooses who
  **may supervise**: a right of its own, not part of being an owner or
  administrator.
- The application needs the `mail.supervise` scope, and asks for it alone,
  naming the employee as subject, the supervisor as actor, and a reason:

  ```
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  subject_token=1234
  subject_token_type=urn:postarix:params:oauth:token-type:external-subject
  actor_token=777
  actor_token_type=urn:postarix:params:oauth:token-type:external-subject
  scope=mail.supervise
  reason=Customer complaint #42
  ```

- **Read-only**: reading methods, downloads and rendered messages only;
  nothing it does changes the read state or any flag, and it cannot send.
- **The employee's own mailbox only**, never their shared mailboxes, never an
  instance administrator's.
- At most an **hour**: the first exchange opens a supervision period; tokens
  stop at its end.
- Recorded in the organization's and the instance's activity (application,
  supervisor, employee, reason), and every request made under it is logged
  (which methods or routes, when; never content). The organization can also
  have the employee told by mail each time.
- Turning supervision off, or taking the right away, ends it at once.

In many countries reading an employee's mail requires a legitimate reason,
proportionality and a written policy people were told about. Postarix records
everything, but cannot judge whether it was allowed.

## Security notes for the application

- Keep the secret, private keys and tokens **on the server**. Never send them
  to a browser: the routes above do not answer cross-origin requests from
  browsers, and a token in a browser would let a script act as the person.
- **Two-step sign-in is the application's job.** A token is not a sign-in:
  the organization's rule requiring a second factor applies to people signing
  in to Postarix, not to applications acting for them. The organization
  trusts the application to sign its users in properly; register only
  applications you trust with that.
- Ask from fixed addresses and set them in the application, so a leaked
  secret cannot be used from elsewhere; prefer `private_key_jwt`.
- Revoking the application, disabling a mailbox, removing someone from a
  shared mailbox or taking supervision away applies to the next request.
