# Unbound: local DNSSEC-validating resolver. DNS blocklists refuse queries
# from public resolvers, and DANE requires validated answers.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends unbound unbound-anchor ca-certificates dns-root-data; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/unbound/unbound.conf.d/*

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

EXPOSE 53/udp 53/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD /usr/local/bin/healthcheck

ENTRYPOINT ["/usr/local/bin/entrypoint"]
