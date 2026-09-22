/**
 * PM2 process definitions.
 *
 * The API runs in cluster mode. Socket.IO is cluster-safe here because socket.ts installs the
 * @socket.io/redis-adapter, and the worker->API event bridge publishes through Redis — so a client
 * connected to any worker receives events produced anywhere. Nginx must still be configured with
 * `ip_hash` (or sticky sessions) for the HTTP long-polling handshake fallback.
 */
module.exports = {
  apps: [
    {
      name: 'embedo-api',
      script: './dist/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      max_memory_restart: '768M',
      kill_timeout: 12000, // > the 10s graceful-shutdown window in server.ts
      wait_ready: false,
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'embedo-worker',
      script: './dist/worker.js',
      instances: 2,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      kill_timeout: 35000, // > the 30s worker drain window in worker.ts
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
