# Postfix image

SMTP reception (25) and submission (587 STARTTLS, 465 implicit TLS). Reads domains, mailboxes, aliases and sender ownership from read-only PostgreSQL views, filters through Rspamd, authenticates through saslauthd and delivers to Cyrus over LMTP. Configuration is rendered from environment variables at start (`rootfs/usr/local/bin/entrypoint`).

See [`docker/README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
