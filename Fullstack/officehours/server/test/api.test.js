'use strict';

// The HTTP API end to end: a real server on a spare port, a real Postgres,
// and the demo data from sql/init.sql restored before every test.
//
// Demo data, for reading the expectations below:
//   CSCI 111  open    ada waiting                      no history (10-min default)
//   CSCI 330  open    grace, then ada, waiting         3 finished sessions: 6, 8, 13 min (avg 9)
//   CSCI 250  closed  empty
//   users: root (all roles), ta/330, ada, grace, linus

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer, JWT_SECRET } = require('./helpers');

let api;
let q; // queue ids by course
let tokens; // a signed-in token per demo account

before(async () => {
  api = await startServer();
});

after(async () => {
  await api.close();
});

beforeEach(async () => {
  await api.reset();
  q = {
    111: await api.queueId('CSCI 111'),
    330: await api.queueId('CSCI 330'),
    250: await api.queueId('CSCI 250'),
  };
  tokens = {};
  for (const name of ['root', 'ta/330', 'ada', 'grace', 'linus']) {
    tokens[name] = await api.login(name);
  }
});

const get = (url, token) => api.request('GET', url, { token });
const post = (url, token, body) => api.request('POST', url, { token, body });
const del = (url, token) => api.request('DELETE', url, { token });

// Accounts the demo data doesn't have, made directly in the database.
const addUser = async (username, role, queueId = null) => {
  await api.pool.query(
    "INSERT INTO users (username, password_hash, role, queue_id) VALUES ($1, crypt('password123', gen_salt('bf')), $2, $3)",
    [username, role, queueId]
  );
  return api.login(username, 'password123');
};

const board = async () => {
  const { body } = await get('/api/queues');
  return Object.fromEntries(body.map((queue) => [queue.name.slice(5, 8), queue]));
};

// ---------------------------------------------------------------------------

describe('the page and the basics', () => {
  it('serves the app with security headers', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.match(res.body, /<title>Office Hours Queue<\/title>/);
  });

  it('reports healthy when the database answers', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, 'string');
  });

  it('rejects malformed JSON with a 400, not a crash', async () => {
    const res = await post('/api/login', undefined, '{"username": "ada",');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body must be valid JSON');
  });

  it('refuses oversized request bodies', async () => {
    const res = await post('/api/register', undefined, { username: 'big', password: 'x'.repeat(20_000) });
    assert.equal(res.status, 413);
  });
});

describe('the public board', () => {
  it('lists every queue with live counts, as numbers', async () => {
    const res = await get('/api/queues');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
    const csci330 = res.body.find((queue) => queue.id === q[330]);
    // COUNT() is a bigint in Postgres; the ::int cast is what makes this a number.
    assert.equal(csci330.waiting, 2);
    assert.equal(csci330.helping, 0);
    assert.equal(typeof csci330.waiting, 'number');
  });

  it('estimates the wait from recent sessions', async () => {
    const queues = await board();
    assert.equal(queues[330].avg_help_minutes, 9);
    assert.equal(queues[330].est_wait_minutes, 18, '2 ahead x 9 min');
    assert.equal(queues[111].avg_help_minutes, 10, 'no history yet: the default');
    assert.equal(queues[111].est_wait_minutes, 10);
    assert.equal(queues[250].est_wait_minutes, null, 'closed queues give no estimate');
  });

  it('shows one queue, or 404 / 400', async () => {
    const res = await get(`/api/queues/${q[330]}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'CSCI 330: Programming Languages');
    assert.equal((await get('/api/queues/9999')).status, 404);
    for (const bad of ['abc', '0', '1e3', '-1', '99999999999']) {
      assert.equal((await get(`/api/queues/${bad}`)).status, 400, bad);
    }
  });

  it('reveals nobody\'s name or question to the public', async () => {
    const text = JSON.stringify((await get('/api/queues')).body);
    for (const secret of ['grace', 'ada', 'closure', 'parser']) {
      assert.equal(text.includes(secret), false, secret);
    }
  });
});

describe('signing in', () => {
  it('returns a token and the user, never the password hash', async () => {
    const res = await post('/api/login', undefined, { username: 'ada', password: 'studentpass' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.deepEqual(Object.keys(res.body.user).sort(), ['id', 'is_root', 'queue_id', 'role', 'username']);
    assert.equal(res.body.user.role, 'student');
  });

  it('ignores the case of usernames', async () => {
    const res = await post('/api/login', undefined, { username: '  ADA ', password: 'studentpass' });
    assert.equal(res.status, 200);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const wrongPassword = await post('/api/login', undefined, { username: 'ada', password: 'nope-nope' });
    const unknownUser = await post('/api/login', undefined, { username: 'nobody', password: 'nope-nope' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(unknownUser.body, wrongPassword.body, 'no hint about which usernames exist');
  });

  it('requires both fields', async () => {
    assert.equal((await post('/api/login', undefined, { username: 'ada' })).status, 400);
    assert.equal((await post('/api/login', undefined, { password: 'x' })).status, 400);
    assert.equal((await post('/api/login', undefined, { username: 'ada', password: ['studentpass'] })).status, 400);
  });

  it('treats SQL in the username as an ordinary (wrong) name', async () => {
    const res = await post('/api/login', undefined, { username: "' OR '1'='1' --", password: "' OR '1'='1" });
    assert.equal(res.status, 401);
  });

  it('reports who is signed in', async () => {
    assert.equal((await get('/api/me', tokens.ada)).body.user.username, 'ada');
    assert.deepEqual((await get('/api/me')).body, { user: null });
    assert.deepEqual((await get('/api/me', 'not-a-token')).body, { user: null });
  });
});

describe('signing up', () => {
  it('creates a student and signs them in', async () => {
    const res = await post('/api/register', undefined, { username: 'Hopper', password: 'compilers!' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'hopper');
    assert.equal(res.body.user.role, 'student');
    assert.equal((await get('/api/me', res.body.token)).body.user.username, 'hopper');
  });

  it('cannot be used to make yourself an admin or a TA', async () => {
    const res = await post('/api/register', undefined, {
      username: 'mallory',
      password: 'password123',
      role: 'admin',
      is_root: true,
      queue_id: q[330],
    });
    assert.equal(res.status, 201);
    assert.deepEqual(
      { role: res.body.user.role, is_root: res.body.user.is_root, queue_id: res.body.user.queue_id },
      { role: 'student', is_root: false, queue_id: null }
    );
    assert.equal((await get('/api/users', res.body.token)).status, 403);
  });

  it('rejects taken and malformed usernames and short passwords', async () => {
    assert.equal((await post('/api/register', undefined, { username: 'ada', password: 'password123' })).status, 409);
    assert.equal((await post('/api/register', undefined, { username: '<script>', password: 'password123' })).status, 400);
    assert.equal((await post('/api/register', undefined, { username: 'newbie', password: 'short' })).status, 400);
  });
});

describe('tokens', () => {
  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ username: 'root' }, 'guessed-secret', { subject: '1' });
    assert.equal((await get('/api/my/tickets', forged)).status, 401);
  });

  it('rejects an unsigned ("alg": "none") token', async () => {
    const encode = (part) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: '1', username: 'root' })}.`;
    assert.equal((await get('/api/users', unsigned)).status, 401);
  });

  it('rejects an expired token', async () => {
    const adaId = String(await api.userId('ada'));
    const fresh = jwt.sign({ username: 'ada' }, JWT_SECRET, { subject: adaId });
    assert.equal((await get('/api/my/tickets', fresh)).status, 200, 'control: same claims, not expired');
    const expired = jwt.sign({ username: 'ada', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET, { subject: adaId });
    assert.equal((await get('/api/my/tickets', expired)).status, 401);
  });

  it('stops working the moment its account is deleted', async () => {
    await api.pool.query("DELETE FROM users WHERE username = 'ada'");
    assert.equal((await get('/api/my/tickets', tokens.ada)).status, 401);
  });

  it('must be sent as a Bearer token', async () => {
    const res = await api.request('GET', '/api/my/tickets', { headers: { authorization: `Token ${tokens.ada}` } });
    assert.equal(res.status, 401);
  });
});

describe('students getting in line', () => {
  it('joins an open queue behind whoever is already there', async () => {
    const res = await post(`/api/queues/${q[111]}/tickets`, tokens.grace, { topic: 'Why is my loop off by one?' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'waiting');
    assert.equal(res.body.queue_id, q[111]);
    assert.equal(res.body.position, 2, 'ada was already waiting');
    assert.equal(res.body.est_wait_minutes, 10, '1 ahead x 10-minute default');
  });

  it('tidies the whitespace in a topic', async () => {
    const res = await post(`/api/queues/${q[111]}/tickets`, tokens.grace, { topic: '  loops \n\n  again ' });
    assert.equal(res.body.topic, 'loops again');
  });

  it('only lets a student hold one place per queue', async () => {
    const res = await post(`/api/queues/${q[330]}/tickets`, tokens.ada, { topic: 'one more thing' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "You're already in line for this queue");
  });

  it('refuses closed and missing queues', async () => {
    const closed = await post(`/api/queues/${q[250]}/tickets`, tokens.ada, { topic: 'heaps' });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, 'This queue is closed');
    assert.equal((await post('/api/queues/9999/tickets', tokens.ada, { topic: 'heaps' })).status, 404);
  });

  it('requires a real topic of 200 characters or fewer', async () => {
    for (const topic of ['', '   ', 'x'.repeat(201), 42, null]) {
      const res = await post(`/api/queues/${q[111]}/tickets`, tokens.grace, { topic });
      assert.equal(res.status, 400, JSON.stringify(topic));
    }
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, tokens.grace, {})).status, 400);
  });

  it('is for students: guests get 401, TAs and admins 403', async () => {
    const dean = await addUser('dean', 'admin');
    const body = { topic: 'help' };
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, undefined, body)).status, 401);
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, tokens['ta/330'], body)).status, 403);
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, dean, body)).status, 403);
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, tokens.root, body)).status, 201, 'root has every role');
  });

  it('stores SQL in a topic as plain text', async () => {
    const topic = "'); DROP TABLE tickets; --";
    const res = await post(`/api/queues/${q[111]}/tickets`, tokens.grace, { topic });
    assert.equal(res.status, 201);
    assert.equal(res.body.topic, topic);
    const { rows } = await api.pool.query('SELECT COUNT(*)::int AS n FROM tickets');
    assert.ok(rows[0].n > 0, 'the tickets table is still there');
  });

  it('stores markup in a topic as plain text (the page must escape it)', async () => {
    const topic = '<img src=x onerror="alert(1)">';
    const res = await post(`/api/queues/${q[111]}/tickets`, tokens.grace, { topic });
    assert.equal(res.body.topic, topic);
  });
});

describe('students watching their place', () => {
  it('lists their tickets with positions and estimates', async () => {
    const res = await get('/api/my/tickets', tokens.ada);
    assert.equal(res.status, 200);
    const [in330, in111] = res.body;
    assert.equal(in330.queue_name, 'CSCI 330: Programming Languages');
    assert.equal(in330.position, 2);
    assert.equal(in330.est_wait_minutes, 9, '1 ahead x 9 min');
    assert.equal(in111.position, 1);
    assert.equal(in111.est_wait_minutes, 0);
  });

  it('moves them up when someone ahead leaves', async () => {
    const grace330 = await api.ticketOf('grace', 'CSCI 330');
    assert.equal((await post(`/api/tickets/${grace330.id}/cancel`, tokens.grace)).status, 200);
    const [in330] = (await get('/api/my/tickets', tokens.ada)).body;
    assert.equal(in330.position, 1);
  });

  it('shows who is helping once a TA takes them', async () => {
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    const [mine] = (await get('/api/my/tickets', tokens.grace)).body;
    assert.equal(mine.status, 'helping');
    assert.equal(mine.helper, 'ta/330');
    assert.equal(mine.position, null);
  });

  it('lets a student leave the line once, then rejoin', async () => {
    const ticket = await api.ticketOf('ada', 'CSCI 111');
    const left = await post(`/api/tickets/${ticket.id}/cancel`, tokens.ada);
    assert.equal(left.status, 200);
    assert.equal(left.body.status, 'canceled');
    assert.equal((await post(`/api/tickets/${ticket.id}/cancel`, tokens.ada)).status, 404);
    assert.equal((await post(`/api/queues/${q[111]}/tickets`, tokens.ada, { topic: 'back again' })).status, 201);
  });

  it('cannot cancel someone else\'s ticket', async () => {
    const grace330 = await api.ticketOf('grace', 'CSCI 330');
    assert.equal((await post(`/api/tickets/${grace330.id}/cancel`, tokens.ada)).status, 404);
    assert.equal((await api.ticketOf('grace', 'CSCI 330')).status, 'waiting');
  });

  it('cannot cancel once a TA has started helping', async () => {
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    const grace330 = await api.ticketOf('grace', 'CSCI 330');
    assert.equal((await post(`/api/tickets/${grace330.id}/cancel`, tokens.grace)).status, 404);
  });
});

describe('TAs', () => {
  it('see their own queue\'s line, in order, with names and topics', async () => {
    const res = await get(`/api/queues/${q[330]}/tickets`, tokens['ta/330']);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((t) => [t.position, t.student, t.status]),
      [
        [1, 'grace', 'waiting'],
        [2, 'ada', 'waiting'],
      ]
    );
    assert.match(res.body[0].topic, /closure/);
  });

  it('cannot see other queues; students and guests cannot see any', async () => {
    assert.equal((await get(`/api/queues/${q[111]}/tickets`, tokens['ta/330'])).status, 403);
    assert.equal((await get(`/api/queues/${q[330]}/tickets`, tokens.ada)).status, 403);
    assert.equal((await get(`/api/queues/${q[330]}/tickets`)).status, 401);
  });

  it('take students first come, first served', async () => {
    const res = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    assert.equal(res.status, 200);
    assert.equal(res.body.student, 'grace');
    assert.equal(res.body.status, 'helping');
    assert.equal(res.body.helper, 'ta/330');
  });

  it('help one student at a time', async () => {
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    const second = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'Finish with your current student first');
    assert.equal((await api.ticketOf('ada', 'CSCI 330')).status, 'waiting', 'ada keeps her place');
  });

  it('finish a session, then take the next student', async () => {
    const first = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    const done = await post(`/api/tickets/${first.body.id}/finish`, tokens['ta/330']);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
    assert.ok(done.body.finished_at);
    const next = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    assert.equal(next.body.student, 'ada');
  });

  it('get a 404 when nobody is waiting', async () => {
    const res = await post(`/api/queues/${q[250]}/claim`, tokens.root);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Nobody is waiting');
  });

  it('cannot take students from another queue; students cannot take anyone', async () => {
    assert.equal((await post(`/api/queues/${q[111]}/claim`, tokens['ta/330'])).status, 403);
    assert.equal((await post(`/api/queues/${q[330]}/claim`, tokens.ada)).status, 403);
  });

  it('can only finish their own sessions (admins can finish any)', async () => {
    const other = await addUser('ta/330b', 'ta', q[330]);
    const dean = await addUser('dean', 'admin');
    const session = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    assert.equal((await post(`/api/tickets/${session.body.id}/finish`, other)).status, 403);
    assert.equal((await post(`/api/tickets/${session.body.id}/finish`, tokens.grace)).status, 403);
    assert.equal((await post(`/api/tickets/${session.body.id}/finish`, dean)).status, 200);
  });

  it('cannot finish a session twice, or one that does not exist', async () => {
    const session = await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    await post(`/api/tickets/${session.body.id}/finish`, tokens['ta/330']);
    assert.equal((await post(`/api/tickets/${session.body.id}/finish`, tokens['ta/330'])).status, 409);
    assert.equal((await post('/api/tickets/9999/finish', tokens['ta/330'])).status, 404);
  });

  it('change the board: one fewer waiting, one being helped', async () => {
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    const queues = await board();
    assert.equal(queues[330].waiting, 1);
    assert.equal(queues[330].helping, 1);
    assert.equal(queues[330].est_wait_minutes, 9);
  });
});

describe('opening and closing queues', () => {
  it('a TA can close and reopen their own queue', async () => {
    const closed = await post(`/api/queues/${q[330]}/close`, tokens['ta/330']);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.is_open, false);
    assert.equal(closed.body.est_wait_minutes, null);
    const opened = await post(`/api/queues/${q[330]}/open`, tokens['ta/330']);
    assert.equal(opened.body.is_open, true);
  });

  it('closing stops new students but the line still gets helped', async () => {
    await post(`/api/queues/${q[330]}/close`, tokens['ta/330']);
    assert.equal((await post(`/api/queues/${q[330]}/tickets`, tokens.linus, { topic: 'late' })).status, 409);
    assert.equal((await post(`/api/queues/${q[330]}/claim`, tokens['ta/330'])).status, 200);
  });

  it('only staff of that queue can open or close it', async () => {
    const dean = await addUser('dean', 'admin');
    assert.equal((await post(`/api/queues/${q[111]}/close`, tokens['ta/330'])).status, 403);
    assert.equal((await post(`/api/queues/${q[111]}/close`, tokens.ada)).status, 403);
    assert.equal((await post(`/api/queues/${q[111]}/close`)).status, 401);
    assert.equal((await post(`/api/queues/${q[111]}/close`, dean)).status, 200, 'admins run every queue');
    assert.equal((await post('/api/queues/9999/open', dean)).status, 404);
  });
});

describe('under concurrency', () => {
  it('never hands the same student to two TAs', async () => {
    // Ten students waiting (grace, ada, then eight more), eight TAs clicking at once.
    for (let i = 0; i < 8; i += 1) {
      await api.pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x')", [`student${i}`]);
      await api.pool.query(
        `INSERT INTO tickets (queue_id, student_id, topic, created_at)
         SELECT $1, id, 'question', NOW() - INTERVAL '1 minute' + $3 * INTERVAL '1 second'
         FROM users WHERE username = $2`,
        [q[330], `student${i}`, i]
      );
    }
    const tas = await Promise.all(
      ['ta/a', 'ta/b', 'ta/c', 'ta/d', 'ta/e', 'ta/f', 'ta/g'].map((name) => addUser(name, 'ta', q[330]))
    );
    tas.push(tokens['ta/330']);

    const claims = await Promise.all(tas.map((token) => post(`/api/queues/${q[330]}/claim`, token)));

    assert.deepEqual(claims.map((c) => c.status), Array(8).fill(200));
    const claimed = claims.map((c) => c.body.id);
    assert.equal(new Set(claimed).size, 8, 'eight different students');

    // And they are exactly the eight who had waited longest.
    const { rows } = await api.pool.query(
      "SELECT id FROM tickets WHERE queue_id = $1 AND status IN ('waiting', 'helping') ORDER BY created_at, id LIMIT 8",
      [q[330]]
    );
    assert.deepEqual(claimed.toSorted((a, b) => a - b), rows.map((r) => r.id).toSorted((a, b) => a - b));
  });

  it('lets a double-clicked join through only once', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => post(`/api/queues/${q[111]}/tickets`, tokens.linus, { topic: 'pointers' }))
    );
    assert.deepEqual(attempts.map((a) => a.status).sort(), [201, 409, 409, 409, 409]);
  });
});

describe('admins', () => {
  it('list everyone, without password hashes', async () => {
    const res = await get('/api/users', tokens.root);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 5);
    assert.equal(JSON.stringify(res.body).includes('password'), false);
    assert.equal(res.body.find((u) => u.username === 'ta/330').queue_name, 'CSCI 330: Programming Languages');
  });

  it('add a TA who can then sign in and work their queue', async () => {
    const res = await post('/api/users', tokens.root, {
      username: 'ta/111',
      password: 'password123',
      role: 'ta',
      queue_id: q[111],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.queue_id, q[111]);
    const ta = await api.login('ta/111', 'password123');
    assert.equal((await post(`/api/queues/${q[111]}/claim`, ta)).body.student, 'ada');
  });

  it('validate new accounts', async () => {
    const add = (body) => post('/api/users', tokens.root, { password: 'password123', ...body });
    assert.equal((await add({ username: 'ta/x', role: 'ta' })).status, 400, 'TA without a queue');
    assert.equal((await add({ username: 'ta/x', role: 'ta', queue_id: 9999 })).body.error, 'No such queue');
    assert.equal((await add({ username: 'boss', role: 'superuser' })).status, 400);
    assert.equal((await add({ username: 'ada' })).status, 409);
    assert.equal((await add({ username: 'Not Valid' })).status, 400);
    assert.equal((await add({ username: 'shorty', password: '123' })).status, 400);
    const student = await add({ username: 'sam' });
    assert.equal(student.body.role, 'student', 'student is the default role');
  });

  it('are the only ones who manage people', async () => {
    assert.equal((await get('/api/users', tokens['ta/330'])).status, 403);
    assert.equal((await get('/api/users', tokens.ada)).status, 403);
    assert.equal((await get('/api/users')).status, 401);
    const dean = await addUser('dean', 'admin');
    assert.equal((await get('/api/users', dean)).status, 200);
  });

  it('delete an account, which signs it out everywhere', async () => {
    const ada = await api.userId('ada');
    const res = await del(`/api/users/${ada}`, tokens.root);
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'ada');
    assert.equal((await get('/api/my/tickets', tokens.ada)).status, 401);
  });

  it('cannot delete root, themselves, or someone who does not exist', async () => {
    const dean = await addUser('dean', 'admin');
    assert.equal((await del(`/api/users/${await api.userId('root')}`, dean)).status, 403);
    assert.equal((await del(`/api/users/${await api.userId('dean')}`, dean)).status, 400);
    assert.equal((await del('/api/users/9999', dean)).status, 404);
    assert.equal((await del('/api/users/abc', dean)).status, 400);
  });

  it('deleting a TA mid-session sends the student back to the front of the line', async () => {
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']); // takes grace
    const res = await del(`/api/users/${await api.userId('ta/330')}`, tokens.root);
    assert.equal(res.status, 200);
    assert.equal(res.body.requeued, 1);
    const [grace] = (await get('/api/my/tickets', tokens.grace)).body;
    assert.equal(grace.status, 'waiting');
    assert.equal(grace.position, 1);
  });
});

describe('wait estimates follow real sessions', () => {
  it('learn from finished sessions', async () => {
    // A 4-minute session in CSCI 111, which had no history.
    await api.pool.query(
      `INSERT INTO tickets (queue_id, student_id, topic, status, created_at, claimed_at, finished_at)
       SELECT $1, id, 'done already', 'done', NOW() - INTERVAL '9 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '1 minute'
       FROM users WHERE username = 'linus'`,
      [q[111]]
    );
    const queues = await board();
    assert.equal(queues[111].avg_help_minutes, 4);
    assert.equal(queues[111].est_wait_minutes, 4, '1 ahead x 4 min');
  });

  it('shorten when more TAs are helping', async () => {
    const second = await addUser('ta/330b', 'ta', q[330]);
    for (const name of ['linus', 'root']) {
      await post(`/api/queues/${q[330]}/tickets`, tokens[name], { topic: 'question' });
    }
    await post(`/api/queues/${q[330]}/claim`, tokens['ta/330']);
    await post(`/api/queues/${q[330]}/claim`, second);
    const queues = await board();
    assert.equal(queues[330].helping, 2);
    assert.equal(queues[330].waiting, 2);
    assert.equal(queues[330].est_wait_minutes, 9, '2 ahead x 9 min / 2 TAs');
  });
});
