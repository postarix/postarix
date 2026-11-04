# Certificate manager for the mail services (Postfix, Cyrus).
# Modes (CERTS_MODE): selfsigned (default), acme (Let's Encrypt via lego), external.
# Writes /certs/fullchain.pem and /certs/privkey.pem; the mail containers watch
# them and reload when they change.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

# lego from its official release, not Debian's package: Debian builds it
# without most DNS providers (Cloudflare among them), so DNS challenges failed
# with "unrecognized DNS provider". Pinned and checked against the release's
# published SHA-256 sums.
ARG LEGO_VERSION=4.35.2
ARG LEGO_SHA256_AMD64=ee5be4bf457de8e3efa86a51651c75c87f0ee0e4e9f3ae14f6034d68365770f3
ARG LEGO_SHA256_ARM64=e1f153179098d27ce044aaaa168c0e323d50ae71b0f1a147aa8ae49ac6b14d89

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssl ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum="$LEGO_SHA256_AMD64" ;; \
      arm64) sum="$LEGO_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    curl -fsSL -o "$tmp/lego.tgz" "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_${arch}.tar.gz"; \
    echo "$sum  $tmp/lego.tgz" | sha256sum -c -; \
    tar -xzf "$tmp/lego.tgz" -C "$tmp" lego; \
    install -m 0755 "$tmp/lego" /usr/local/bin/lego; \
    rm -rf "$tmp"; \
    lego --version; \
    lego dnshelp -c cloudflare >/dev/null

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/*

# HTTP-01 challenges (ACME mode only, when chosen).
EXPOSE 80
VOLUME ["/certs", "/var/lib/lego"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
  CMD [ -s /certs/fullchain.pem ] && [ -s /certs/privkey.pem ] && [ -s /certs/api-privkey.pem ]

ENTRYPOINT ["/usr/local/bin/certs"]
