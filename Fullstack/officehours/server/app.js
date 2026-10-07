'use strict';

const path = require('node:path');
const express = require('express');
const logic = require('./logic');
const { withTransaction } = require('./db');
const { signToken, verifyToken, bearerToken } = require('./auth');
const { SQL } = require('./queries');

// When Postgres refuses a write, say *why* in terms a person understands.
// Keys are the constraint and index names from sql/init.sql.
const CONSTRAINT_ERRORS = {
  one_active_ticket_per_student: [409, "You're already in line for this queue"],
  one_student_per_helper: [409, 'Finish with your current student first'],
  users_username_key: [409, 'That username is taken'],
  users_queue_id_fkey: [400, 'No such queue'],
};

const publicUser = ({ id, username, role, queue_id, is_root }) => ({
  id,
  username,
  role,
  queue_id,
  is_root,
});

const createApp = ({ pool, jwtSecret, jwtExpiry = '8h', log = console }) => {
  if (!pool) throw new Error('createApp needs a database pool');
  if (!jwtSecret) throw new Error('createApp needs a JWT secret');

  const app = express();
  app.disable('x-powered-by');

  // Defense in depth for the browser: even if some markup slipped through, a
  // Content-Security-Policy without 'unsafe-inline' refuses to run inline
  // scripts or onerror= handlers. The page loads only its own files.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
        "form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json({ limit: '10kb' }));

  const session = (user) => ({
    token: signToken(user, jwtSecret, jwtExpiry),
    user: publicUser(user),
  });

  // Who is calling? The token proves identity; the database is asked, every
  // time, what that identity is currently allowed to do.
  const loadUser = async (req) => {
    const token = bearerToken(req.get('authorization'));
    const userId = token ? verifyToken(token, jwtSecret) : null;
    if (userId === null) return null;
    const { rows } = await pool.query(SQL.userById, [userId]);
    return rows[0] ?? null;
  };

  const authenticate = async (req, res, next) => {
    req.user = await loadUser(req);
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    next();
  };

  const allow = (permitted, message) => (req, res, next) =>
    permitted(req) ? next() : res.status(403).json({ error: message });

  const idParam = (label) => (req, res, next) => {
    req.id = logic.parseId(req.params.id);
    if (req.id === null) return res.status(400).json({ error: `Invalid ${label} id` });
    next();
  };

  // Live rows for the board, plus each queue's recent history for estimates.
  // The two queries don't depend on each other, so they run concurrently.
  const loadQueues = async (queueId = null) => {
    const [queues, finished] = await Promise.all([
      pool.query(SQL.queues, [queueId]),
      pool.query(SQL.recentFinished, [logic.RECENT_SAMPLE]),
    ]);
    const history = logic.groupBy(finished.rows, (row) => row.queue_id);
    return { rows: queues.rows, historyOf: (id) => history.get(id) ?? [] };
  };

  const queueSummaries = async (queueId = null) => {
    const { rows, historyOf } = await loadQueues(queueId);
    return rows.map((queue) => logic.summarizeQueue(queue, historyOf(queue.id)));
  };

  const myTickets = async (studentId) => {
    const [{ rows: tickets }, { rows: queues, historyOf }] = await Promise.all([
      pool.query(SQL.myTickets, [studentId]),
      loadQueues(),
    ]);
    const helping = new Map(queues.map((queue) => [queue.id, queue.helping]));
    return tickets.map((ticket) =>
      logic.describeTicket(ticket, historyOf(ticket.queue_id), helping.get(ticket.queue_id))
    );
  };

  const staffTicket = async (ticketId) => {
    const { rows } = await pool.query(SQL.staffTicket, [ticketId]);
    return rows[0];
  };

  // ---- health & accounts --------------------------------------------------

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      log.error('Health check failed:', err.message);
      res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const username = logic.normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const { rows } = await pool.query(SQL.login, [username, password]);
    if (rows.length === 0) return res.status(401).json({ error: 'Wrong username or password' });
    res.json(session(rows[0]));
  });

  app.post('/api/register', async (req, res) => {
    const username = logic.validateUsername(req.body?.username);
    const password = logic.validatePassword(req.body?.password);
    const error = username.error ?? password.error;
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(SQL.register, [username.value, password.value]);
    res.status(201).json(session(rows[0]));
  });

  app.get('/api/me', async (req, res) => {
    const user = await loadUser(req);
    res.json({ user: user ? publicUser(user) : null });
  });

  // ---- queues: public -----------------------------------------------------

  app.get('/api/queues', async (req, res) => {
    res.json(await queueSummaries());
  });

  app.get('/api/queues/:id', idParam('queue'), async (req, res) => {
    const [queue] = await queueSummaries(req.id);
    if (!queue) return res.status(404).json({ error: 'Queue not found' });
    res.json(queue);
  });

  // ---- queues: staff ------------------------------------------------------

  const staffOfQueue = (req) => logic.canStaffQueue(req.user, req.id);

  const setOpen = (isOpen) => async (req, res) => {
    const { rows } = await pool.query(SQL.setOpen, [req.id, isOpen]);
    if (rows.length === 0) return res.status(404).json({ error: 'Queue not found' });
    const [queue] = await queueSummaries(req.id);
    res.json(queue);
  };

  app.post(
    '/api/queues/:id/open',
    authenticate,
    idParam('queue'),
    allow(staffOfQueue, 'Only staff for this queue can open it'),
    setOpen(true)
  );

  app.post(
    '/api/queues/:id/close',
    authenticate,
    idParam('queue'),
    allow(staffOfQueue, 'Only staff for this queue can close it'),
    setOpen(false)
  );

  app.get(
    '/api/queues/:id/tickets',
    authenticate,
    idParam('queue'),
    allow(staffOfQueue, 'Only staff for this queue can see who is in it'),
    async (req, res) => {
      const { rows } = await pool.query(SQL.queueTickets, [req.id]);
      res.json(rows);
    }
  );

  app.post(
    '/api/queues/:id/claim',
    authenticate,
    idParam('queue'),
    allow((req) => logic.canHelpQueue(req.user, req.id), 'Only TAs for this queue can take students'),
    async (req, res) => {
      const { rows } = await pool.query(SQL.claimNext, [req.id, req.user.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Nobody is waiting' });
      res.json(await staffTicket(rows[0].id));
    }
  );

  // ---- tickets: students --------------------------------------------------

  app.post(
    '/api/queues/:id/tickets',
    authenticate,
    idParam('queue'),
    allow((req) => logic.isStudent(req.user), 'Only students can join a queue'),
    async (req, res) => {
      const topic = logic.validateTopic(req.body?.topic);
      if (topic.error) return res.status(400).json({ error: topic.error });

      const { rows } = await pool.query(SQL.join, [req.id, req.user.id, topic.value]);
      if (rows.length === 0) {
        // Nothing inserted: the queue is either missing or closed. Find out which.
        const exists = await pool.query(SQL.queueExists, [req.id]);
        return exists.rows.length === 0
          ? res.status(404).json({ error: 'Queue not found' })
          : res.status(409).json({ error: 'This queue is closed' });
      }

      const tickets = await myTickets(req.user.id);
      res.status(201).json(tickets.find((ticket) => ticket.id === rows[0].id));
    }
  );

  app.get('/api/my/tickets', authenticate, async (req, res) => {
    res.json(await myTickets(req.user.id));
  });

  app.post('/api/tickets/:id/cancel', authenticate, idParam('ticket'), async (req, res) => {
    const { rows } = await pool.query(SQL.cancel, [req.id, req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'You have no waiting ticket with that id' });
    }
    res.json(rows[0]);
  });

  // ---- tickets: staff -----------------------------------------------------

  app.post('/api/tickets/:id/finish', authenticate, idParam('ticket'), async (req, res) => {
    const { rows } = await pool.query(SQL.ticketById, [req.id]);
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!logic.canFinishTicket(req.user, ticket)) {
      return res.status(403).json({ error: 'Only the TA helping this student can finish' });
    }

    const updated = await pool.query(SQL.finish, [req.id, req.user.id, logic.isAdmin(req.user)]);
    if (updated.rows.length === 0) {
      return res.status(409).json({ error: 'That student is not being helped right now' });
    }
    res.json(await staffTicket(req.id));
  });

  // ---- users: admins ------------------------------------------------------

  const adminsOnly = allow((req) => logic.isAdmin(req.user), 'Admins only');

  app.get('/api/users', authenticate, adminsOnly, async (req, res) => {
    const { rows } = await pool.query(SQL.users);
    res.json(rows);
  });

  app.post('/api/users', authenticate, adminsOnly, async (req, res) => {
    const body = req.body ?? {};
    const username = logic.validateUsername(body.username);
    const password = logic.validatePassword(body.password);
    const role = logic.validateRole(body.role ?? undefined, body.queue_id ?? null);
    const error = username.error ?? password.error ?? role.error;
    if (error) return res.status(400).json({ error });

    const { rows } = await pool.query(SQL.createUser, [
      username.value,
      password.value,
      role.value.role,
      role.value.queueId,
    ]);
    res.status(201).json(rows[0]);
  });

  app.delete('/api/users/:id', authenticate, adminsOnly, idParam('user'), async (req, res) => {
    if (req.id === req.user.id) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }

    // Three statements that must happen together or not at all.
    const result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(SQL.lockUser, [req.id]);
      const user = rows[0];
      if (!user) return { status: 404, body: { error: 'User not found' } };
      if (user.is_root) return { status: 403, body: { error: 'The root account cannot be deleted' } };

      const requeued = await client.query(SQL.requeueHelped, [req.id]);
      await client.query(SQL.deleteUser, [req.id]);
      return {
        status: 200,
        body: { id: user.id, username: user.username, requeued: requeued.rowCount },
      };
    });

    res.status(result.status).json(result.body);
  });

  // ---- everything else ----------------------------------------------------

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'No such endpoint' });
  });

  // Express 5 sends errors thrown by async handlers here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (Object.hasOwn(CONSTRAINT_ERRORS, err.constraint ?? '')) {
      const [status, error] = CONSTRAINT_ERRORS[err.constraint];
      return res.status(status).json({ error });
    }

    // Class 23 is "integrity constraint violation": a CHECK, NOT NULL, foreign
    // key or unique rule said no. The request was invalid; the server is fine.
    if (typeof err.code === 'string' && err.code.startsWith('23')) {
      return res.status(400).json({ error: 'That change is not allowed' });
    }

    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON' });
    }
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'Bad request' });
    }

    log.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
};

module.exports = { createApp };
