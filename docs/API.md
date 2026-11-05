# API reference

Everything the admin panel and the webmail do goes through the Postarix API,
and so can your scripts and applications.

- **On your server:** `https://<your server>/api/docs` is a browsable
  reference of every route, built from the code that serves it, and
  `https://<your server>/api/openapi.json` is its
  [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) description. It always
  matches the version you run.
- **Here:** the description of the latest version is published as
  [openapi.json](/openapi.json). Load it into any OpenAPI tool (Swagger UI,
  Postman, Insomnia) or a client generator (`openapi-generator`,
  `openapi-typescript`…).

## How to authenticate

| Who | How | Reaches |
|---|---|---|
| A person | The session cookie from `POST /api/auth/sign-in/email`; requests that change something send the `Origin` of the panel or webmail | What their role allows |
| A script | An **API key**: `Authorization: Bearer px_…` (Administration → API keys) | The whole instance as an administrator, or one organization's `/api/orgs/{orgId}/…` only; read-only keys only read |
| A connected application | A **token**: `Authorization: Bearer pxt_…` from `POST /api/oauth/token` | JMAP and `/api/mail` as one person, by scope (see [Integrating another application](integrations.md)) |

Routes under `/api/orgs/{orgId}/` are for that organization's owners and
administrators (some for owners only); another organization's data answers
404, as if it did not exist. Routes under `/api/system/` are for instance
administrators.

Errors are JSON, for example
`{ "statusCode": 422, "message": "Verify the domain before adding mailboxes", "code": "DOMAIN_NOT_VERIFIED" }`;
validation errors list their `issues`.

## Common tasks with an API key

```bash
KEY=px_…   # limited to one organization
API=https://mail.example.com/api
ORG=…      # the organization's id

# A person's mailbox
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"domainId": "…", "localPart": "ana", "displayName": "Ana", "password": "a long first password"}' \
  $API/orgs/$ORG/mailboxes

# A shared mailbox, and a member who may send from it
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"domainId": "…", "localPart": "support", "kind": "shared", "displayName": "Support"}' \
  $API/orgs/$ORG/mailboxes
curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"rights": "send"}' $API/orgs/$ORG/mailboxes/<shared mailbox id>/members/<userId>

# Link a person to their id in your application
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"mailboxId": "…", "issuer": "https://helpdesk.example.com", "subject": "1234"}' \
  $API/orgs/$ORG/identities
```

The full list, with every field, is in the reference.
