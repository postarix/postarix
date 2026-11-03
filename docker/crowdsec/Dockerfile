# CrowdSec: watches the Postfix and Cyrus logs (shared logs volume) for
# password guessing and spam abuse, and decides which addresses to block.
# Blocking itself happens on the host, with a firewall bouncer that asks this
# container's local API (see docs/CROWDSEC.md): containers never touch the
# host firewall.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    # A non-empty file tells the package not to register with CrowdSec's
    # central API at build time: an image must not carry one shared identity.
    mkdir -p /etc/crowdsec; \
    echo '# central API disabled (see docs/CROWDSEC.md)' > /etc/crowdsec/online_api_credentials.yaml; \
    apt-get update; \
    apt-get install -y --no-install-recommends crowdsec ca-certificates curl openssl; \
    rm -rf /var/lib/apt/lists/*; \
    # Local decisions only: no central API client.
    sed -i '/^\s*online_client:/,/online_api_credentials.yaml/d' /etc/crowdsec/config.yaml; \
    # The package's sample acquisition (nginx, apache, journald…) does not apply.
    rm -f /etc/crowdsec/acquis.yaml; \
    # Enable the Postfix detection from the package's offline copy of the hub
    # (what "cscli collections install crowdsecurity/postfix" does, without
    # the network).
    hub=/usr/share/crowdsec/hub; \
    ln -sf "$hub/parsers/s01-parse/crowdsecurity/postfix-logs.yaml" /etc/crowdsec/parsers/s01-parse/postfix-logs.yaml; \
    ln -sf "$hub/scenarios/crowdsecurity/postfix-spam.yaml" /etc/crowdsec/scenarios/postfix-spam.yaml; \
    ln -sf "$hub/collections/crowdsecurity/postfix.yaml" /etc/crowdsec/collections/postfix.yaml

COPY rootfs/ /

RUN chmod 0755 /usr/local/bin/*

EXPOSE 8080

VOLUME ["/var/lib/crowdsec/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD cscli lapi status >/dev/null 2>&1

ENTRYPOINT ["/usr/local/bin/entrypoint"]
