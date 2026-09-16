FROM node:22-alpine AS build

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
 && pnpm --filter @personal-intelligence-hub/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace /app
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@personal-intelligence-hub/web", "start"]
