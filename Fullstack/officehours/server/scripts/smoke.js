'use strict';

// Smoke test for a running stack: CI runs this inside the app container after
// `docker compose up`. It checks the things the other tests can't -- that the
// image has everything it needs, that init.sql was mounted and loaded, and
// that the app and database containers can reach each other.
//
//   node scripts/smoke.js [base-url]

const base = process.argv[2] || 'http://127.0.0.1:3000';

const fetchJson = async (path, init) => {
  const response = await fetch(base + path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const checks = {
  'the page is served': async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    if (!response.ok || !html.includes('<title>Office Hours Queue</title>')) {
      throw new Error(`GET / answered ${response.status}`);
    }
  },
  'the database answers': async () => {
    const health = await fetchJson('/api/health');
    if (!health.ok) throw new Error(JSON.stringify(health));
  },
  'init.sql loaded the demo queues': async () => {
    const queues = await fetchJson('/api/queues');
    if (queues.length !== 3) throw new Error(`expected 3 queues, found ${queues.length}`);
  },
  'a demo account can sign in': async () => {
    const { token } = await fetchJson('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'rootpass' }),
    });
    const { user } = await fetchJson('/api/me', { headers: { authorization: `Bearer ${token}` } });
    if (user?.username !== 'root') throw new Error(`signed in as ${user?.username}`);
  },
};

const run = async () => {
  let failed = 0;
  for (const [name, check] of Object.entries(checks)) {
    try {
      await check();
      console.log(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}: ${err.message}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
};

run();
