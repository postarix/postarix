# ClamAV (optional): virus scanning for Rspamd. clamd answers on TCP 3310 on
# the internal network; freshclam keeps the signatures current.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends clamav-daemon clamav-freshclam ca-certificates curl openssl; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /var/lib/clamav/*.cvd /var/lib/clamav/*.cld

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

EXPOSE 3310

VOLUME ["/var/lib/clamav"]

# Loading the signatures takes a while (and memory: about 1.5 GB).
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD /usr/local/bin/healthcheck

ENTRYPOINT ["/usr/local/bin/entrypoint"]
