# CrowdSec: watches the Postfix and Cyrus logs (shared logs volume) for
# password guessing and spam abuse, and decides which addresses to block.
# Blocking itself happens on the host, with a firewall bouncer that asks this
# container's local API (see docs/CROWDSEC.md): containers never touch the
# host firewall.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends crowdsec ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    # The package's sample acquisition (nginx, apache, journald…) does not apply.
    rm -f /etc/crowdsec/acquis.yaml

COPY rootfs/ /

RUN chmod 0755 /usr/local/bin/*

EXPOSE 8080

VOLUME ["/var/lib/crowdsec/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD cscli lapi status >/dev/null 2>&1

ENTRYPOINT ["/usr/local/bin/entrypoint"]
