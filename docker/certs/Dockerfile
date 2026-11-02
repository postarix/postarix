# Certificate manager for the mail services (Postfix, Cyrus).
# Modes (CERTS_MODE): selfsigned (default), acme (Let's Encrypt via lego), external.
# Writes /certs/fullchain.pem and /certs/privkey.pem; the mail containers watch
# them and reload when they change.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends lego openssl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

# HTTP-01 challenges (ACME mode only, when chosen).
EXPOSE 80
VOLUME ["/certs", "/var/lib/lego"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
  CMD [ -s /certs/fullchain.pem ] && [ -s /certs/privkey.pem ]

ENTRYPOINT ["/usr/local/bin/certs"]
