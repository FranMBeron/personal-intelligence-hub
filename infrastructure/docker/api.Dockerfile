ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY integrations/hermes/package.json integrations/hermes/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/tooling/package.json packages/tooling/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @personal-intelligence-hub/contracts build \
 && pnpm --filter @personal-intelligence-hub/database build \
 && pnpm --filter @personal-intelligence-hub/api build \
 && pnpm --filter @personal-intelligence-hub/api deploy --prod /opt/api

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1 \
 && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /opt/api/ ./
USER node
EXPOSE 3001
CMD ["node", "dist/src/main.js"]
