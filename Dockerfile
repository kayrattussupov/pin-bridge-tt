# syntax=docker/dockerfile:1

# ---- build: full toolchain, also used by the one-shot `migrate` service ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
# prisma.config.ts reads DATABASE_URL; generation itself never connects.
RUN DATABASE_URL=postgresql://build@localhost/build npx prisma generate
COPY src ./src
RUN npm run build

# ---- prod-deps: runtime dependencies only ----
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# @prisma/client declares the Prisma CLI and TypeScript as optional peers, so npm installs them
# even with --omit=dev. They are only needed for generate/migrate (done in the build stage).
RUN npm ci --omit=dev \
  && rm -rf node_modules/prisma node_modules/typescript \
    node_modules/@prisma/dev node_modules/@prisma/studio-core node_modules/@prisma/engines \
    node_modules/@prisma/fetch-engine node_modules/@prisma/get-platform node_modules/@prisma/config \
    node_modules/effect node_modules/@electric-sql node_modules/elkjs \
    node_modules/mysql2 node_modules/deepmerge-ts \
    node_modules/.bin/prisma node_modules/.bin/tsc node_modules/.bin/tsserver \
  && npm cache clean --force

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 3001
# Overridden per service in docker-compose.yml (api vs worker).
CMD ["node", "dist/main.api.js"]
