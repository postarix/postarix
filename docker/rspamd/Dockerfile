# Rspamd: spam filtering (milter for Postfix), SPF/DKIM/DMARC/ARC checks and DKIM signing.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends rspamd ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

# 11332 milter (Postfix) · 11334 controller (web UI / API, internal)
EXPOSE 11332 11334
VOLUME ["/var/lib/rspamd"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:11334/ping >/dev/null

ENTRYPOINT ["/usr/local/bin/entrypoint"]
