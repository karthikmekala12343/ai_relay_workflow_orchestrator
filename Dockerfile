FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /app
COPY . .
RUN npm ci \
  && npm run db:generate \
  && npm run build \
  && npm prune --omit=dev

FROM base

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app

CMD ["npm", "run", "start", "--workspace", "@relay/api"]
