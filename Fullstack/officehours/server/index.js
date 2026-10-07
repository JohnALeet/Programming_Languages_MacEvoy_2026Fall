'use strict';

// Entry point: read configuration, connect, listen. Everything else lives in
// app.js, which takes its database pool and secret as arguments -- that is
// what lets the tests start a real server on a spare port against a test
// database without touching any environment variables.

const crypto = require('node:crypto');
const { createPool } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Missing DATABASE_URL, e.g. postgres://officehours_user:officehours_pass@localhost:5432/officehours'
  );
  process.exit(1);
}

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Missing JWT_SECRET; refusing to start in production without one.');
    process.exit(1);
  }
  // A fresh random secret per run, rather than a well-known default anyone
  // could use to forge tokens. Cost: restarting the server signs everyone out.
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET not set; using a random secret for this run.');
}

const pool = createPool(databaseUrl);
const app = createApp({ pool, jwtSecret });

const server = app.listen(port, () => {
  console.log(`Office hours queue listening on port ${port}`);
});

// `docker compose stop` sends SIGTERM. Stop accepting connections, let
// requests already in flight finish, then close the database pool.
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
