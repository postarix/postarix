# Postarix admin panel (Next.js, served under /admin). Build from the repository root:
#   docker build -f apps/admin/Dockerfile -t postarix/admin .
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/ui/package.json packages/ui/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @postarix/admin...
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY apps/admin apps/admin
# Where the admin server forwards /api when the reverse proxy does not route it
# itself. Next.js fixes rewrites at build time.
ARG API_INTERNAL_URL=http://postarix-api:3000
ENV NEXT_TELEMETRY_DISABLED=1
RUN API_INTERNAL_URL="$API_INTERNAL_URL" pnpm --filter @postarix/admin build \
 && mkdir -p /out \
 && cp -r apps/admin/.next/standalone/. /out/ \
 && cp -r apps/admin/.next/static /out/apps/admin/.next/static

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/admin/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/admin/server.js"]
