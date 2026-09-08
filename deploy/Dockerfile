# syntax=docker/dockerfile:1.7
FROM node:22.20-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b

FROM node:22.20-alpine AS runtime
ARG CAPITALDESK_SERVICE
ENV NODE_ENV=production
ENV CAPITALDESK_SERVICE=${CAPITALDESK_SERVICE}
WORKDIR /workspace
COPY --from=build --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /workspace/packages ./packages
COPY --from=build --chown=10001:10001 /workspace/apps/${CAPITALDESK_SERVICE}/dist ./apps/${CAPITALDESK_SERVICE}/dist
COPY --chmod=0555 deploy/scripts/start-service.sh /usr/local/bin/capitaldesk-start
USER 10001:10001
ENTRYPOINT ["capitaldesk-start"]
CMD ["sh", "-c", "exec node apps/${CAPITALDESK_SERVICE}/dist/main.js"]
