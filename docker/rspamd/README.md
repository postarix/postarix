# Rspamd image

Spam filtering as a Postfix milter, with Valkey for Bayes and other state. The controller (11334) is internal; its password is stored only as a hash.

- Signs authenticated mail with each domain's DKIM key and seals it with ARC (keys published to Valkey by the API).
- `rspamd.local.lua` adds the `POSTARIX_FROM_NOT_OWNED` prefilter: authenticated mail must have exactly one `From` address, equal to the envelope sender (which Postfix already ties to the login). Otherwise it is rejected before signing.

See [`docker/README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
