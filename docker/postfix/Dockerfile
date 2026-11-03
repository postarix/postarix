# Postfix: SMTP reception (25) and submission (587, 465).
# Reads domains, mailboxes and aliases from read-only PostgreSQL views, filters
# through Rspamd, authenticates through the saslauthd socket shared by the
# Cyrus container, and delivers to Cyrus over LMTP.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      postfix postfix-pgsql libsasl2-modules sasl2-bin ca-certificates openssl netcat-openbsd gettext-base curl; \
    rm -rf /var/lib/apt/lists/*; \
    # Installed without debconf configuration: start from an empty main.cf,
    # the entrypoint sets every parameter explicitly.
    touch /etc/postfix/main.cf; \
    # Run every service unchrooted: the container is the isolation boundary, and
    # chrooted smtpd could not reach the shared saslauthd socket.
    postconf -F '*/*/chroot = n'

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

EXPOSE 25 465 587
VOLUME ["/var/spool/postfix"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD /usr/local/bin/healthcheck

ENTRYPOINT ["/usr/local/bin/entrypoint"]
