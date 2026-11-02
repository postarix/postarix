# Postarix API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t postarix/api .
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/mail-engine/package.json packages/mail-engine/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @postarix/api...
COPY packages/config packages/config
COPY packages/mail-engine packages/mail-engine
COPY apps/api apps/api
RUN pnpm --filter @postarix/api... build \
 && pnpm --filter @postarix/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/drizzle /out/

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Apply pending migrations, then start the API.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
