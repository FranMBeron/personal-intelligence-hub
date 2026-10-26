ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/connectors/package.json apps/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

COPY apps/connectors apps/connectors
COPY packages/contracts packages/contracts
COPY tsconfig*.json ./
RUN pnpm --filter @personal-intelligence-hub/contracts build \
 && pnpm --filter @personal-intelligence-hub/connectors build \
 && pnpm --filter @personal-intelligence-hub/connectors deploy --prod /opt/connectors \
 && cp -R apps/connectors/dist /opt/connectors/dist \
 && rm -f /opt/connectors/node_modules/.pnpm/node_modules/@personal-intelligence-hub/connectors \
 && find /opt/connectors -type l | while IFS= read -r link; do \
      target=$(readlink -f "$link") || { echo "Dangling symlink in connectors bundle: $link" >&2; exit 1; }; \
      case "$target" in /opt/connectors/*) ;; *) echo "Symlink escapes connectors bundle: $link" >&2; exit 1 ;; esac; \
    done

FROM scratch AS export
COPY --from=build /opt/connectors /opt/connectors
