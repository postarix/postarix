# Cyrus IMAP image

IMAP, POP3, ManageSieve, JMAP, CalDAV and CardDAV, plus saslauthd (PAM → `pam_exec` → Postarix API) for every mail login. Admin rights are only granted on the internal admin port (1143); LMTP (24) and HTTP (8080) are internal too.

See [`docker/README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
