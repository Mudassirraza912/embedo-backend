# ⚡ Embedo.ai — Backend API & AI Generation Engine

Production-ready backend API and agentic AI hardware generation engine for [Embedo.ai](https://embedo.ai) — transforming natural language hardware specifications into Functional Block Diagrams, Power Trees, Protocol Maps, and Bill of Materials (BOM).

---

## 🏗️ Architecture & Technology Stack

- **Runtime & Language**: Node.js 20+ (ESM), TypeScript (Strict Mode)
- **Web Framework**: Express.js with Helmet security, CORS, and Zod schema validation
- **Real-time Engine**: Socket.IO (`/ws/sessions`) for stage-by-stage AI streaming
- **Task Queue & Async Workers**: BullMQ powered by Redis 7
- **Database & ORM**: PostgreSQL 16 with `pgvector` extension via Prisma ORM
- **AI Models**:
  - **Sol Tier (`gpt-4o`)**: Deep relational hardware synthesis, power rail mapping & BOM generation
  - **Luna Tier (`gpt-4o-mini`)**: Real-time intent extraction, Discuss-First hardware copilot & moderation
  - **Embedding (`text-embedding-3-small`)**: 1536-dimensional vector search against datasheets & knowledge base
- **API Documentation**: Interactive OpenAPI 3.0 & Swagger UI playground at `/docs`

---

## 📂 Project Structure

```
embedo-backend/
├── prisma/
│   ├── schema.prisma         # Full database models (Sessions, Users, AI Calls Data Moat, Components, Vectors)
│   └── seed.ts               # Model routes & default AI configuration seed
├── src/
│   ├── common/               # Errors, auth & validation middlewares
│   ├── config/               # Environment (Zod fail-fast), logger (Pino), Swagger OpenAPI
│   ├── db/                   # Prisma client & Redis client instances
│   ├── jobs/                 # BullMQ queue definitions (ai-pipeline, export, ingest, refresh)
│   ├── modules/
│   │   ├── ai/               # AI Facade, Provider Adapters (OpenAI, Anthropic, Google) & Dynamic Router
│   │   ├── auth/             # JWT auth, bcrypt, rotating refresh token cookies, consent gates
│   │   ├── governance/       # 3-tier moderation (Regex wordlists + OpenAI Moderation + IP strike tracking)
│   │   ├── realtime/         # Socket.IO session room manager & event emitters
│   │   ├── sessions/         # 7-Step AI Generation Pipeline, Discuss-First copilot & routes
│   │   └── users/            # Profile management, PII scrubbing on account soft-delete
│   ├── server.ts             # Express HTTP + Socket.IO server entrypoint
│   └── worker.ts             # BullMQ background job processor entrypoint
├── tests/                    # Jest unit & API integration test suites (Supertest)
├── Dockerfile                # Multi-stage production container
├── docker-compose.yml        # Local development databases (PostgreSQL + pgvector + Redis)
├── docker-compose.prod.yml   # Production VPS full-stack Docker Compose
└── ecosystem.config.cjs      # PM2 process configuration for native VPS deployments
```

---

## 🚀 Quickstart: Local Development

### 1. Prerequisites
- **Node.js**: `v20.0.0` or higher
- **Docker Desktop** (for PostgreSQL + pgvector and Redis)
- **OpenAI API Key** (with access to `gpt-4o` and `gpt-4o-mini`)

### 2. Installation
```bash
cd embedo-backend
npm install
```

### 3. Environment Configuration
Copy the environment template and set your credentials:
```bash
cp .env.example .env
```
Ensure `.env` contains:
```env
PORT=4000
NODE_ENV=development
API_PREFIX=/api/v1
CORS_ORIGIN=http://localhost:3000,http://localhost:5173

# Database & Redis
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/embedo?schema=public"
REDIS_URL="redis://localhost:6379"

# Security & Secrets
JWT_ACCESS_SECRET="your-super-secret-access-jwt-key"
JWT_REFRESH_SECRET="your-super-secret-refresh-jwt-key"

# AI Provider API Keys
OPENAI_API_KEY="sk-proj-your-openai-api-key"
```

### 4. Start Local Databases
Start PostgreSQL (with `pgvector`) and Redis:
```bash
docker-compose up -d
```

### 5. Run Database Migrations & Seed

```bash
# Apply migrations (forward-only; safe on an existing database)
npm run db:migrate:deploy:dev

# Seed default model routes. Idempotent: existing rows are never overwritten.
npm run db:seed

# Optional: bootstrap an admin account (credentials come from env, never from source)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm run db:seed
```

> `npm run db:push` exists for throwaway local prototyping only. **Never** run it against staging or
> production — it has no history and can drop columns. Production uses `db:migrate:deploy`, which
> baselines an existing `db push` database automatically on first run.

### 6. Start the Application
In your terminal, start the API server:
```bash
npm run dev
```

In a separate terminal window, start the BullMQ background worker:
```bash
npm run worker
```

- **API Base URL**: `http://localhost:4000/api/v1`
- **Interactive Swagger UI**: `http://localhost:4000/docs`
- **Health Check**: `http://localhost:4000/api/v1/health`
- **Prisma Studio**: `npm run db:studio` (GUI to view DB records)

---

## 🧪 Testing & Verification

```bash
# Everything CI runs, in one command
npm run verify          # typecheck + lint + unit tests

# Individually
npm run typecheck       # tsc --noEmit
npm run lint            # ESLint (includes the AI-provider import boundary rule)
npm run test:unit       # Jest — fully isolated: no network, no database
npm run build           # Compile to dist/
```

The unit suite mocks Prisma, Redis and all AI providers, so it never makes a paid API call or
touches a database. CI additionally runs `prisma migrate deploy` against a throwaway
Postgres+pgvector service to prove migrations apply cleanly from empty.

## 🔐 Security & Operations Notes

**Required in production** (`deploy.sh` refuses to deploy without them):

| Variable | Why it is required |
| :--- | :--- |
| `NODE_ENV=production` | Enables secure cookies, hides error internals, gates `/docs`, sets moderation fail-closed |
| `OPENAI_API_KEY` | Sol/Luna generation, embeddings and Tier-2 moderation all route to it. Startup fails without it (no mock-key fallback) |
| `JWT_ACCESS_SECRET` | Must be random; placeholder-looking values are rejected at boot |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | Compose has no insecure defaults — it fails if unset |

**Optional but behaviour-changing:**

| Variable | Effect when unset |
| :--- | :--- |
| `GOOGLE_CLIENT_ID` | `POST /auth/google` returns 503. The ID-token audience check is never skipped — Google sign-in fails closed rather than accepting tokens minted for other apps |
| `SMTP_*` | Password-reset emails are not sent; `forgot-password` still returns its generic message and logs an error. The reset token is never returned in an API response or written to a log |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | `/admin/queues` (Bull Board) and production `/docs` are reachable only with an **admin JWT** |
| `INGEST_ALLOWED_DOMAINS` | Datasheet ingestion accepts any public HTTPS host (private/link-local/metadata ranges are always blocked) |
| `MODERATION_FAIL_MODE` | Defaults to `closed` in production: if a moderation provider errors, the request is refused rather than allowed through |

**Operator surfaces** (never public):

- `GET /admin/queues` — Bull Board. Requires admin JWT or dashboard Basic auth.
- `GET|POST /api/v1/admin/*` — ingestion + catalog. Requires `requireAuth` + `requireRole('admin')`.
- `GET /docs` — Swagger. Open in development, admin-gated in production.

**Rate limits & quotas** (per `CLAUDE.md §4`):

| Scope | Limit |
| :--- | :--- |
| Global, per IP | `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` (default 100/min) |
| Auth endpoints, per IP | 10/min |
| Password reset, per IP | 3/hour |
| Session creation | Guests 5/hour **per IP**, users 20/hour per account, plus `SESSION_CREATE_DAILY_MAX_PER_IP` (default 50/day) as an absolute cost ceiling |
| Discuss refinement | 30/hour per session |
| Guest messages | 6 per session · Free users 20 per session · 3 architectures in flight |
| Moderation strikes | `MODERATION_STRIKE_LIMIT` within `MODERATION_STRIKE_WINDOW_SECONDS` → temporary suspension for `MODERATION_SUSPENSION_SECONDS` (applies to guests **and** users) |

Guest session tokens are **server-issued** (32 random bytes, hex). A client-supplied
`x-anon-session-token` is only honoured if it matches that format and an existing session.

**Export formats:** `json` and `svg` are implemented and downloadable via
`GET /api/v1/sessions/:id/export/download?format=…`. `kicad` and `altium` return
`501 EXPORT_FORMAT_UNSUPPORTED` — they are not silently substituted with JSON.

## 🌐 Interactive Swagger API Playground

Open **`http://localhost:4000/docs`** in your browser. Frontend developers can directly explore request/response schemas and test endpoints:

- `POST /api/v1/auth/register` — Signup with data consent
- `POST /api/v1/auth/login` — Authenticate & receive JWT
- `POST /api/v1/sessions` — Create session & trigger 7-step hardware generation
- `POST /api/v1/sessions/:id/discuss` — Discuss-First copilot chat
- `GET /api/v1/sessions/:id/architecture` — Retrieve Functional Block, Power Tree, Protocol Map & BOM
- `POST /api/v1/sessions/:id/feedback` — Submit user telemetry
- `POST /api/v1/sessions/:id/export` — Export to KiCad / Altium / JSON

---

## 🚢 Production VPS Deployment Guide

You can deploy `embedo-backend` to any Ubuntu VPS (e.g. DigitalOcean, Hetzner, AWS EC2, Linode, Hostinger).

### ⚡ Automated 1-Script Deployment (`deploy.sh`)

An automated deployment script [`deploy.sh`](./deploy.sh) is included that validates your environment, installs dependencies, syncs Prisma database schemas, compiles TypeScript, reloads PM2 with zero downtime, and performs an automated health check:

```bash
# Make executable (first time only)
chmod +x deploy.sh

# Run automated deployment (PM2 native)
./deploy.sh

# Or run automated Docker Compose deployment
./deploy.sh --docker
```

---

### Manual Deployment Options

#### Option A: Docker Compose Deployment (Recommended)

This is the cleanest and most isolated deployment method.

#### 1. Prepare VPS
SSH into your server and install Docker + Docker Compose:
```bash
# Update Ubuntu packages
sudo apt update && sudo apt upgrade -y

# Install Docker & Docker Compose Plugin
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

#### 2. Clone Repository & Setup Environment
```bash
git clone <your-repository-url> /opt/embedo
cd /opt/embedo/embedo-backend

# Create production .env file
cp .env.example .env
nano .env
```
Set your production variables:
```env
PORT=4000
NODE_ENV=production
API_PREFIX=/api/v1
CORS_ORIGIN=https://embedo.ai,https://app.embedo.ai

POSTGRES_USER=embedo_admin
POSTGRES_PASSWORD=your_ultra_secure_db_password
POSTGRES_DB=embedo_prod
DATABASE_URL="postgresql://embedo_admin:your_ultra_secure_db_password@postgres:5432/embedo_prod?schema=public"

REDIS_PASSWORD=your_ultra_secure_redis_password
REDIS_URL="redis://:your_ultra_secure_redis_password@redis:6379"

JWT_ACCESS_SECRET="generate-with-openssl-rand-hex-64"
JWT_REFRESH_SECRET="generate-with-openssl-rand-hex-64"

OPENAI_API_KEY="sk-proj-your-openai-api-key"
```

#### 3. Build & Launch Containers
```bash
# Build and run all services (PostgreSQL + pgvector, Redis, API, Worker)
docker compose -f docker-compose.prod.yml up -d --build

# Run database migrations inside the API container
docker compose -f docker-compose.prod.yml exec api node dist/scripts/migrate.js
docker compose -f docker-compose.prod.yml exec api npx tsx prisma/seed.ts
```

#### 4. Monitor & View Logs
```bash
# View all service status
docker compose -f docker-compose.prod.yml ps

# View API logs
docker compose -f docker-compose.prod.yml logs -f api

# View Worker logs
docker compose -f docker-compose.prod.yml logs -f worker
```

---

### Option B: Native Deployment (Node.js + PM2 + Nginx + SSL Certbot)

For setups matching standard VPS node stacks with PM2 process manager and Nginx reverse proxy:

#### 1. Install Node.js 20, PostgreSQL & Redis
```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx redis-server

# Install PM2 globally
sudo npm install -g pm2
```

#### 2. Setup PostgreSQL with `pgvector`
```bash
sudo apt install -y postgresql postgresql-contrib
# Install pgvector extension
sudo apt install -y postgresql-16-pgvector

# Create database & user
sudo -u postgres psql
```
Inside psql prompt:
```sql
CREATE USER embedo_user WITH PASSWORD 'your_secure_password';
CREATE DATABASE embedo_prod OWNER embedo_user;
\c embedo_prod;
CREATE EXTENSION IF NOT EXISTS vector;
\q
```

#### 3. Build Application & Seed
```bash
cd /var/www/embedo-backend
npm ci
cp .env.example .env
nano .env # Set production environment values

# Generate Prisma client, push schema, seed, and compile TS
npx prisma generate
node dist/scripts/migrate.js
npm run db:seed
npm run build
```

#### 4. Start with PM2
```bash
# Start API cluster and worker processes
pm2 start ecosystem.config.cjs --env production

# Save PM2 process list and configure auto-start on server reboot
pm2 save
sudo pm2 startup
```

#### 5. Configure Nginx Reverse Proxy & WebSockets
Create `/etc/nginx/sites-available/api.embedo.ai`:
```nginx
server {
    server_name api.embedo.ai;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;

        # WebSocket support for Socket.IO (/ws/sessions)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-running AI streams
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}
```
Enable the site and obtain a free SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/api.embedo.ai /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Issue free SSL Certificate with Let's Encrypt
sudo certbot --nginx -d api.embedo.ai
```

---

## 🛠️ Operational Commands Reference

| Action | Command |
| :--- | :--- |
| **Inspect DB via Web GUI** | `npm run db:studio` |
| **Create a migration (dev)** | `npm run db:migrate` |
| **Apply migrations (staging/prod)** | `npm run db:migrate:deploy` |
| **Re-seed Model Routes** | `npm run db:seed` |
| **PM2 Process Status** | `pm2 status` |
| **PM2 Logs Stream** | `pm2 logs` |
| **PM2 Zero-downtime Reload** | `pm2 reload all` |
| **Docker Compose Status** | `docker compose -f docker-compose.prod.yml ps` |
| **Docker Compose Restart** | `docker compose -f docker-compose.prod.yml restart` |

---

## 📄 License
Private and Proprietary — Embedo.ai © 2026. All Rights Reserved.
