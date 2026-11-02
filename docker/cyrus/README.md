# Cyrus IMAP image

IMAP, POP3, ManageSieve, CalDAV and CardDAV, plus saslauthd (PAM → `pam_exec` → Postarix API) for every mail login. Admin rights (and the admin account itself) only exist on the internal admin port (1143). HTTP (8080, plain: TLS ends at the reverse proxy) is internal too, and LMTP is served on a Unix socket in the `lmtp-socket` volume shared with Postfix. JMAP will get its own internal service, reached only through the API, with the webmail.

See [`docker/README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
