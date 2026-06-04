FROM node:20-slim AS base

# python3 + build-essential are needed for native module builds (sharp, etc.).
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runner

WORKDIR /app

# Copy with ownership set to the built-in `node` user (uid 1000)
# so the non-root runtime user can read everything without a
# follow-up `chown -R` step.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.json ./

ENV NODE_ENV=production

# Container port is assigned at runtime by the host (Railway injects $PORT).
# Server reads process.env.PORT in src/index.ts. No EXPOSE / HEALTHCHECK here —
# the host's own healthcheck (configured in Railway dashboard / railway.toml)
# probes /health on the correct port. A Dockerfile HEALTHCHECK with a
# hardcoded port will fail every deploy and cause SIGTERMs.

# Drop root before running the app.
USER node

CMD ["npm", "start"]
