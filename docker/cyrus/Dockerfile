# Cyrus IMAP: mailboxes, IMAP/POP3, ManageSieve, CalDAV and CardDAV. Also runs
# as a Cyrus Murder backend, frontend or mupdate server (CYRUS_ROLE).
# Also runs saslauthd, which validates mail logins against the Postarix API
# (PAM → pam_exec → /api/internal/mail-auth) for both Cyrus and Postfix.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      cyrus-imapd cyrus-caldav cyrus-pop3d cyrus-admin cyrus-murder \
      sasl2-bin libsasl2-modules libpam-modules \
      rsyslog ca-certificates curl openssl gettext-base; \
    rm -rf /var/lib/apt/lists/*; \
    # The package ships a sample config; ours replaces it at startup.
    rm -f /etc/imapd.conf /etc/cyrus.conf; \
    # Service names Cyrus looks up (a Murder connects to backends by them).
    for entry in 'imap 143/tcp' 'lmtp 24/tcp' 'mupdate 3905/tcp'; do \
      grep -q "^${entry%% *}[[:space:]]" /etc/services || echo "$entry" >> /etc/services; \
    done

COPY rootfs/ /

RUN chmod 0755 /usr/local/bin/*

# 143 IMAP (STARTTLS) · 993 IMAPS · 995 POP3S · 4190 ManageSieve
# 1143 admin IMAP, 8008 JMAP (for the API) and 8080 HTTP (CalDAV/CardDAV) are internal only; LMTP is a Unix socket.
EXPOSE 143 993 995 4190 1143 8008 8080

VOLUME ["/var/lib/cyrus", "/var/spool/cyrus", "/var/spool/sieve", "/run/saslauthd"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD /usr/local/bin/healthcheck

ENTRYPOINT ["/usr/local/bin/entrypoint"]
