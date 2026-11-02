# Cyrus IMAP: mailboxes, IMAP/POP3, ManageSieve, JMAP, CalDAV and CardDAV.
# Also runs saslauthd, which validates mail logins against the Postarix API
# (PAM → pam_exec → /api/internal/mail-auth) for both Cyrus and Postfix.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      cyrus-imapd cyrus-caldav cyrus-pop3d cyrus-admin \
      sasl2-bin libsasl2-modules libpam-modules \
      busybox-syslogd ca-certificates curl openssl gettext-base; \
    rm -rf /var/lib/apt/lists/*; \
    # The package ships a sample config; ours replaces it at startup.
    rm -f /etc/imapd.conf /etc/cyrus.conf

COPY rootfs/ /

RUN chmod 0755 /usr/local/bin/*

# 143 IMAP (STARTTLS) · 993 IMAPS · 995 POP3S · 4190 ManageSieve
# 24 LMTP, 1143 admin IMAP and 8080 HTTP (JMAP/DAV) are internal only.
EXPOSE 143 993 995 4190 24 1143 8080

VOLUME ["/var/lib/cyrus", "/var/spool/cyrus", "/var/spool/sieve", "/run/saslauthd"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD /usr/local/bin/healthcheck

ENTRYPOINT ["/usr/local/bin/entrypoint"]
