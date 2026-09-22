# Deployment Notes — Embedo.ai on VPS

Deployment architecture and operations guide based on the standard eSpark VPS structure.

---

## 1. Server Layout

- **Backend App Directory**: `/home/etcpanel/apps/embedo-api/` (owned by `etcpanel`, source + compose file live here — images are built on the server from this checkout)
- **Frontend Document Root**: `/home/etcpanel/app.embedo.ai/` (or your subdomain)
- **Runtime**: all backend services run as Docker containers via `docker-compose.prod.yml`, orchestrated with **`etcpanel` in the `docker` group** (no `sudo`/root needed to run `docker compose`):
  - `embedo-prod-api`: Express HTTP + Socket.IO API server, published as `127.0.0.1:4000` only
  - `embedo-prod-worker`: BullMQ background worker (AI generation pipeline & export processor)
  - `embedo-prod-postgres`: PostgreSQL 16 + `pgvector`, data in the `postgres_data` named volume
  - `embedo-prod-redis`: Redis 7, data in the `redis_data` named volume
- **Host requirements**: Docker Engine + the `docker compose` plugin, and Nginx (for TLS termination / reverse proxy only — Postgres, Redis and Node itself are **not** installed on the host).

---

## 2. Automated Deployment Script (`deploy.sh`)

From your local machine (in the root directory `/Users/MAC/Desktop/Ideas/ReactNext/Embedo`), run:

### Deploy Backend Only:
```bash
VPS_PASSWORD='your_vps_root_password' ./deploy.sh backend
```

### Deploy Frontend Only:
```bash
VPS_PASSWORD='your_vps_root_password' ./deploy.sh frontend
```

### Deploy Full Stack (Backend + Frontend):
```bash
VPS_PASSWORD='your_vps_root_password' ./deploy.sh all
```

*(If using SSH keys instead of password, simply omit `VPS_PASSWORD='...'`)*

---

## 3. What `deploy.sh` Executes

1. **Rsyncs source files** to VPS (`$BACKEND_DIR`), excluding `node_modules`, `.env`, `dist`, `.git`, `tests`.
2. **Sets ownership** to `$APP_USER` (`etcpanel`).
3. **Builds images**: `docker compose -f docker-compose.prod.yml build` (multi-stage `Dockerfile` — compiles TypeScript and runs `prisma generate` inside the build stage).
4. **Brings up stateful services**: `docker compose ... up -d postgres redis`, so migrations/seed hit an already-healthy database.
5. **Applies migrations**: `docker compose ... run --rm api node dist/scripts/migrate.js` (forward-only `prisma migrate deploy`, auto-baselines a database that was originally created with `db push`). **`prisma db push` is never used in production.**
6. **Seeds model routes & AI configs**: `docker compose ... run --rm api npm run db:seed`. This step is not wrapped in `|| true` — a failed seed aborts the deploy before step 7 touches the running containers.
7. **Starts/updates api and worker**: `docker compose ... up -d --remove-orphans`, which recreates only the containers whose image or config changed.
8. **Builds and deploys frontend**: `npm run build` (runs locally, not on the VPS) $\rightarrow$ rsyncs `dist/` to `$FRONTEND_DOCROOT` $\rightarrow$ `chown`.

The seed is idempotent: it creates missing model routes and, if `ADMIN_EMAIL` is set, an admin
account. **It never rewrites an existing admin password** and contains no hardcoded credentials.

> **Note:** `deploy.sh` does not currently validate `.env` contents (e.g. that `OPENAI_API_KEY` is
> set, or that secrets aren't left as placeholders) before deploying — that must be checked by hand
> per §5 below. If you want this automated, it belongs as a preflight step in `deploy.sh` before
> the `docker compose build` call.

> **Important:** the API container binds to `127.0.0.1:4000`, not `0.0.0.0` (see
> `docker-compose.prod.yml`'s `ports:` mapping). Express runs with `trust proxy = 1`, so it derives
> the client IP from `X-Forwarded-For`. If port 4000 were reachable directly, that header could be
> spoofed to bypass every IP-based rate limit. Keep Nginx as the only ingress path — never publish
> the api/worker containers on `0.0.0.0`.

## 4. Web Server / Reverse Proxy Configuration

### Nginx Configuration (`/etc/nginx/sites-available/api.embedo.ai`)
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

---

## 5. Secrets Management

Environment variables live in a single `/home/etcpanel/apps/embedo-api/.env` on the VPS (mode 600,
owned by `etcpanel`) and are never overwritten by `deploy.sh`. This one file does double duty:

- `docker compose` reads it automatically (because it sits next to `docker-compose.prod.yml`) to
  resolve the `${POSTGRES_PASSWORD:?...}` / `${REDIS_PASSWORD:?...}` placeholders **in the compose
  file itself**.
- It is also passed verbatim into the `api`/`worker` containers via `env_file:` — and `env_file`
  values are **not** `${...}`-expanded. `DATABASE_URL`/`REDIS_URL` must therefore repeat the literal
  password rather than reference the other variable, and must point at the Docker service names
  (`postgres`, `redis`), not `localhost`.

```env
PORT=4000
NODE_ENV=production
API_PREFIX=/api/v1
CORS_ORIGIN=https://app.embedo.ai,https://embedo.ai

# Consumed directly by docker-compose.prod.yml's ${...} substitution:
POSTGRES_USER=embedo_user
POSTGRES_PASSWORD=your_postgres_password
POSTGRES_DB=embedo_prod
REDIS_PASSWORD=your_redis_password

# Consumed by the api/worker containers — passwords and hostnames repeated literally, not ${...}:
DATABASE_URL="postgresql://embedo_user:your_postgres_password@postgres:5432/embedo_prod?schema=public"
REDIS_URL="redis://:your_redis_password@redis:6379"

JWT_ACCESS_SECRET="your_jwt_access_secret_64_chars"
JWT_REFRESH_SECRET="your_jwt_refresh_secret_64_chars"

OPENAI_API_KEY="sk-proj-your-openai-key"
```
