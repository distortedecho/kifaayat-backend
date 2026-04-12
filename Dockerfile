FROM node:20-slim AS base

# curl is needed at runtime for the HEALTHCHECK probe below.
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    curl \
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
ENV PORT=3001

EXPOSE 3001

# Liveness probe — hits the public /health route every 30s.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Drop root before running the app.
USER node

CMD ["npm", "start"]
