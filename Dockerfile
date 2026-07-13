# ---- Build stage ----
FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Prune dev dependencies for the runtime layer.
RUN pnpm prune --prod

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

# kubectl is required by runbook actions in live mode.
# Version pinned for reproducible builds.
ARG KUBECTL_VERSION=v1.31.4
ADD https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl /usr/local/bin/kubectl
RUN chmod +x /usr/local/bin/kubectl

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Non-root user: the agent needs no privileges inside its own container.
RUN addgroup -S agent && adduser -S agent -G agent \
    && mkdir -p /app/data && chown -R agent:agent /app/data
USER agent

EXPOSE 3000

# Incident history lives in /app/data — mount a volume to persist it.
ENV INCIDENT_FILE_PATH=/app/data/incidents.jsonl

CMD ["node", "dist/index.js"]