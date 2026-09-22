#!/usr/bin/env bash

# ==============================================================================
# Embedo.ai Backend — Automated Production Deployment Script
# ==============================================================================
# Usage:
#   ./deploy.sh          (Deploys using PM2 native Node.js process manager)
#   ./deploy.sh --docker (Deploys using Docker Compose)
# ==============================================================================

set -e # Exit immediately on any error

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Print header
echo -e "${CYAN}==============================================================================${NC}"
echo -e "${CYAN}   🚀 Embedo.ai Backend — Production Deployment Starting...                   ${NC}"
echo -e "${CYAN}==============================================================================${NC}"
echo ""

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

# 1. Check for .env file and production guard-rails
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Error: .env file not found in $DEPLOY_DIR${NC}"
    echo -e "${YELLOW}Please create a .env file from .env.example before deploying.${NC}"
    exit 1
fi
echo -e "${GREEN}✔ .env file detected.${NC}"

ENV_NODE_ENV=$(grep -E '^NODE_ENV=' .env | cut -d '=' -f2 | tr -d '"' | tr -d "'" || true)
if [ "$ENV_NODE_ENV" != "production" ]; then
    echo -e "${RED}❌ Refusing to deploy: NODE_ENV in .env is '${ENV_NODE_ENV:-unset}', expected 'production'.${NC}"
    exit 1
fi
if grep -qE '^(JWT_ACCESS_SECRET|DASHBOARD_PASSWORD)=.*(your-|change-me|placeholder|example)' .env; then
    echo -e "${RED}❌ Refusing to deploy: placeholder secrets detected in .env.${NC}"
    exit 1
fi
if ! grep -qE '^OPENAI_API_KEY=sk-' .env; then
    echo -e "${RED}❌ Refusing to deploy: OPENAI_API_KEY is not set in .env.${NC}"
    exit 1
fi

# Check deployment mode
MODE="pm2"
if [ "$1" == "--docker" ]; then
    MODE="docker"
fi

if [ "$MODE" == "docker" ]; then
    echo -e "${BLUE}▶ Mode: Docker Compose Deployment${NC}"
    
    # Check Docker & Docker Compose
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Error: docker is not installed or not in PATH.${NC}"
        exit 1
    fi

    echo -e "${BLUE}▶ Step 1: Building and starting production Docker containers...${NC}"
    docker compose -f docker-compose.prod.yml up -d --build

    echo -e "${BLUE}▶ Step 2: Applying database migrations in container (forward-only, baseline-aware)...${NC}"
    docker compose -f docker-compose.prod.yml exec -T api node dist/scripts/migrate.js

    echo -e "${BLUE}▶ Step 2b: Seeding model routes / admin bootstrap (idempotent, never overwrites)...${NC}"
    if ! docker compose -f docker-compose.prod.yml exec -T api npx tsx prisma/seed.ts; then
        echo -e "${RED}❌ Seed failed. Aborting deploy.${NC}"
        exit 1
    fi

    echo -e "${BLUE}▶ Step 3: Checking container status...${NC}"
    docker compose -f docker-compose.prod.yml ps

else
    echo -e "${BLUE}▶ Mode: Native PM2 Cluster Deployment${NC}"

    # Check Node.js & PM2
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Error: node is not installed or not in PATH.${NC}"
        exit 1
    fi
    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}⚠️  pm2 is not installed globally. Installing pm2...${NC}"
        npm install -g pm2
    fi

    echo -e "${CYAN}Node Version: $(node -v)${NC}"
    echo -e "${CYAN}NPM Version:  $(npm -v)${NC}"

    # Step 1: Install Dependencies
    echo -e "\n${BLUE}▶ Step 1: Installing production dependencies...${NC}"
    npm ci --production=false

    # Step 2: Compile TypeScript first so the migration runner exists in dist/
    echo -e "\n${BLUE}▶ Step 2: Generating Prisma Client & compiling TypeScript (dist/)...${NC}"
    npx prisma generate
    npm run build

    # Step 3: Forward-only migrations (baseline-aware). NEVER `prisma db push` in production.
    echo -e "\n${BLUE}▶ Step 3: Applying database migrations...${NC}"
    node dist/scripts/migrate.js

    # Step 4: Seed (idempotent: creates missing model routes / admin only, never overwrites)
    echo -e "\n${BLUE}▶ Step 4: Seeding model routes & admin bootstrap...${NC}"
    if ! npm run db:seed; then
        echo -e "${RED}❌ Seed failed. Aborting deploy.${NC}"
        exit 1
    fi

    # Step 5: Reload / Start PM2 Services
    echo -e "\n${BLUE}▶ Step 5: Reloading PM2 processes with zero downtime...${NC}"
    if pm2 describe embedo-api > /dev/null 2>&1; then
        echo -e "${GREEN}Reloading existing PM2 cluster...${NC}"
        pm2 reload ecosystem.config.cjs --env production
    else
        echo -e "${GREEN}Starting new PM2 cluster...${NC}"
        pm2 start ecosystem.config.cjs --env production
    fi

    # Save PM2 process list
    pm2 save
fi

# Step 6: Post-Deployment Health Check
echo -e "\n${BLUE}▶ Step 6: Running post-deployment health check...${NC}"
PORT=$(grep -E '^PORT=' .env | cut -d '=' -f2 | tr -d '"' | tr -d "'" || echo "4000")
PORT=${PORT:-4000}
HEALTH_URL="http://localhost:${PORT}/api/v1/health"

MAX_RETRIES=10
RETRY_COUNT=0
HEALTHY=false

echo -e "Waiting for API service to respond at ${HEALTH_URL}..."
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
    if [ "$HTTP_STATUS" == "200" ]; then
        HEALTHY=true
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT+1))
    echo -e "${YELLOW}Attempt $RETRY_COUNT/$MAX_RETRIES: Status $HTTP_STATUS — retrying in 2 seconds...${NC}"
    sleep 2
done

if [ "$HEALTHY" = true ]; then
    echo -e "${GREEN}✔ Health check PASSED (HTTP 200 OK)!${NC}"
else
    echo -e "${RED}❌ Health check FAILED after $MAX_RETRIES attempts.${NC}"
    if [ "$MODE" == "docker" ]; then
        docker compose -f docker-compose.prod.yml logs --tail=50 api
    else
        pm2 logs embedo-api --lines 30 --nostream
    fi
    exit 1
fi

echo ""
echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}   ✨ Embedo.ai Backend Deployment Completed Successfully!                   ${NC}"
echo -e "${GREEN}==============================================================================${NC}"
if [ "$MODE" == "pm2" ]; then
    pm2 status
fi
echo -e "${CYAN}API Endpoint:   http://localhost:${PORT}/api/v1${NC}"
echo -e "${CYAN}Swagger Docs:   http://localhost:${PORT}/docs${NC}"
echo ""
