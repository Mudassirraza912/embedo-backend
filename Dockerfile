# ==========================================================
# Embedo Backend — Multi-stage Production Dockerfile
# ==========================================================

# Stage 1: Build & Compile
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

RUN npm ci

COPY src ./src/

RUN npx prisma generate
RUN npm run build

# Keep only production dependencies (prisma CLI + tsx are production deps: migrations/seed run in-container)
RUN npm prune --omit=dev

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards signals so graceful shutdown works as PID 1.
# openssl must match what prisma generate detected in the builder stage above, or the query
# engine binary fails to load at runtime (Prisma defaults to a guessed OpenSSL version when
# it can't detect one, which silently produces a binary incompatible with this base image).
RUN apk add --no-cache tini curl openssl

COPY --chown=node:node package*.json ./
COPY --chown=node:node prisma ./prisma/
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
# Runtime data files (datasheet manifest / mirrors) read from src/data at runtime
COPY --chown=node:node src/data ./src/data/

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Default command runs the HTTP + WebSocket API Server (worker overrides CMD in compose)
CMD ["node", "dist/server.js"]
