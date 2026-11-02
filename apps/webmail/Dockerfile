# Postarix webmail (static React app + a tiny Node server). Build from the repository root:
#   docker build -f apps/webmail/Dockerfile -t postarix/webmail .
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/ui/package.json packages/ui/
COPY packages/jmap-client/package.json packages/jmap-client/
COPY apps/webmail/package.json apps/webmail/
RUN pnpm install --frozen-lockfile --filter @postarix/webmail...
COPY packages/config packages/config
COPY packages/ui packages/ui
COPY packages/jmap-client packages/jmap-client
COPY apps/webmail apps/webmail
RUN pnpm --filter @postarix/webmail build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/webmail/dist ./dist
COPY --from=build --chown=node:node /repo/apps/webmail/server.mjs ./server.mjs
USER node
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
