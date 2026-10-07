'use strict';

// Shared test plumbing: a real server on a spare port, wired to a real
// Postgres, reset to the demo data before every test.

const { createPool } = require('../db');
const { createApp } = require('../app');
const { resetDatabase, DEFAULT_DATABASE_URL } = require('../scripts/reset-db');

const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const JWT_SECRET = 'test-only-secret';

// Demo accounts from sql/init.sql.
const PASSWORDS = {
  root: 'rootpass',
  'ta/330': 'tapass123',
  ada: 'studentpass',
  grace: 'studentpass',
  linus: 'studentpass',
};

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

const startServer = async ({ log = quiet } = {}) => {
  const pool = createPool(DATABASE_URL);
  const app = createApp({ pool, jwtSecret: JWT_SECRET, log });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // fetch() with JSON in and out. `body` may be a raw string, to send bad JSON.
  const request = async (method, url, { token, body, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(baseUrl + url, init);
    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (e.g. the HTML page); keep the text
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };

  const login = async (username, password = PASSWORDS[username]) => {
    const response = await request('POST', '/api/login', { body: { username, password } });
    if (response.status !== 200) {
      throw new Error(`login as ${username} failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body.token;
  };

  // Look things up by name rather than hard-coding ids the seed happens to produce.
  const queueId = async (prefix) => {
    const { rows } = await pool.query('SELECT id FROM queues WHERE name LIKE $1', [`${prefix}%`]);
    return rows[0].id;
  };
  const userId = async (username) => {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    return rows[0].id;
  };
  const ticketOf = async (username, queuePrefix) => {
    const { rows } = await pool.query(
      `SELECT t.* FROM tickets t
       JOIN users u ON u.id = t.student_id
       JOIN queues q ON q.id = t.queue_id
       WHERE u.username = $1 AND q.name LIKE $2
       ORDER BY t.id DESC LIMIT 1`,
      [username, `${queuePrefix}%`]
    );
    return rows[0];
  };

  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };

  return {
    pool,
    baseUrl,
    request,
    login,
    queueId,
    userId,
    ticketOf,
    reset: () => resetDatabase(pool),
    close,
  };
};

module.exports = { DATABASE_URL, JWT_SECRET, PASSWORDS, createPool, resetDatabase, startServer };
