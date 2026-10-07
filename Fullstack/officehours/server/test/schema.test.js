'use strict';

// The database's own rules, tested by talking to Postgres directly -- no API in
// between. Each test tries to store something impossible and checks that the
// *named* constraint from sql/init.sql is the one that refuses it.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPool, resetDatabase, DATABASE_URL } = require('./helpers');

describe('database constraints', () => {
  let pool;
  let ids;

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  // Assert that a statement fails because of one specific constraint.
  const refusedBy = async (constraint, sql, params = []) => {
    await assert.rejects(pool.query(sql, params), (err) => {
      assert.equal(err.constraint, constraint, `expected ${constraint}, got: ${err.message}`);
      return true;
    });
  };

  // created_at defaults to a minute ago, so a claimed_at or finished_at of
  // "now" (this machine's clock) is safely after it.
  const insertTicket = (given) => {
    const fields = { created_at: new Date(Date.now() - 60_000), ...given };
    const columns = Object.keys(fields);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    return pool.query(
      `INSERT INTO tickets (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      Object.values(fields)
    );
  };

  before(() => {
    pool = createPool(DATABASE_URL);
  });

  after(() => pool.end());

  beforeEach(async () => {
    await resetDatabase(pool);
    const queue = async (prefix) => (await one('SELECT id FROM queues WHERE name LIKE $1', [`${prefix}%`])).id;
    const user = async (name) => (await one('SELECT id FROM users WHERE username = $1', [name])).id;
    ids = {
      q111: await queue('CSCI 111'),
      q330: await queue('CSCI 330'),
      q250: await queue('CSCI 250'),
      ta: await user('ta/330'),
      ada: await user('ada'),
      grace: await user('grace'),
      linus: await user('linus'),
    };
  });

  it('loads the demo data', async () => {
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM queues')).n, 3);
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM users')).n, 5);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM tickets WHERE status = 'waiting'")).n, 3);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM tickets WHERE status = 'done'")).n, 3);
  });

  it('stores passwords hashed, never as typed', async () => {
    const { password_hash: hash } = await one("SELECT password_hash FROM users WHERE username = 'ada'");
    assert.notEqual(hash, 'studentpass');
    assert.match(hash, /^\$2[abxy]?\$/, 'a bcrypt hash');
  });

  describe('tickets', () => {
    it('only allow the four known statuses', async () => {
      await refusedBy('valid_status', 'INSERT INTO tickets (queue_id, student_id, topic, status) VALUES ($1, $2, $3, $4)', [
        ids.q250, ids.linus, 'x', 'lost',
      ]);
    });

    it('cannot be waiting and have a helper', async () => {
      await refusedBy('waiting_is_untouched', 'INSERT INTO tickets (queue_id, student_id, topic, helper_id) VALUES ($1, $2, $3, $4)', [
        ids.q250, ids.linus, 'x', ids.ta,
      ]);
    });

    it('cannot be "helping" without a helper and a claim time', async () => {
      await assert.rejects(insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic: 'x', status: 'helping', claimed_at: new Date() }), {
        constraint: 'helping_has_helper',
      });
    });

    it('cannot be done without having been claimed', async () => {
      await assert.rejects(insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic: 'x', status: 'done', finished_at: new Date() }), {
        constraint: 'done_was_helped',
      });
    });

    it('cannot be canceled after a TA claimed it', async () => {
      const now = new Date();
      await assert.rejects(
        insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic: 'x', status: 'canceled', claimed_at: now, finished_at: now }),
        { constraint: 'canceled_was_never_helped' }
      );
    });

    it('cannot finish before it was created', async () => {
      await assert.rejects(
        insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic: 'x', status: 'canceled', finished_at: new Date(Date.now() - 3600_000) }),
        { constraint: 'time_moves_forward' }
      );
    });

    it('need a trimmed topic of 1-200 characters', async () => {
      for (const topic of ['', '  padded  ', 'x'.repeat(201)]) {
        await assert.rejects(insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic }), { constraint: 'topic_length' }, JSON.stringify(topic));
      }
      // 200 characters is fine, even when each is a 2-unit emoji in JavaScript.
      await insertTicket({ queue_id: ids.q250, student_id: ids.linus, topic: '\u{1F41B}'.repeat(200) });
    });
  });

  describe('fairness rules', () => {
    it('keep a student to one active ticket per queue', async () => {
      // ada is already waiting in CSCI 330.
      await assert.rejects(insertTicket({ queue_id: ids.q330, student_id: ids.ada, topic: 'again' }), {
        constraint: 'one_active_ticket_per_student',
      });
    });

    it('let a student line up again once their old ticket is finished', async () => {
      await pool.query("UPDATE tickets SET status = 'canceled', finished_at = NOW() WHERE student_id = $1 AND queue_id = $2", [
        ids.ada, ids.q330,
      ]);
      await insertTicket({ queue_id: ids.q330, student_id: ids.ada, topic: 'second question' });
    });

    it('let a student wait in two different queues', async () => {
      await insertTicket({ queue_id: ids.q250, student_id: ids.ada, topic: 'linked lists' });
    });

    it('keep a TA to one student at a time', async () => {
      const claim = "UPDATE tickets SET status = 'helping', helper_id = $1, claimed_at = NOW() WHERE id = $2";
      const waiting = await pool.query("SELECT id FROM tickets WHERE queue_id = $1 AND status = 'waiting' ORDER BY id", [ids.q330]);
      await pool.query(claim, [ids.ta, waiting.rows[0].id]);
      await refusedBy('one_student_per_helper', claim, [ids.ta, waiting.rows[1].id]);
    });
  });

  describe('users', () => {
    const addUser = (username, role, queueId = null) =>
      pool.query("INSERT INTO users (username, password_hash, role, queue_id) VALUES ($1, 'x', $2, $3)", [username, role, queueId]);

    it('give every TA a queue, and nobody else one', async () => {
      await assert.rejects(addUser('ta/x', 'ta'), { constraint: 'ta_has_queue' });
      await assert.rejects(addUser('sam', 'student', ids.q111), { constraint: 'ta_has_queue' });
      await addUser('ta/111', 'ta', ids.q111);
    });

    it('only allow the three roles', async () => {
      await assert.rejects(addUser('mallory', 'superuser'), { constraint: 'valid_role' });
    });

    it('refuse usernames that are not plain lowercase names', async () => {
      for (const username of ['<script>', 'Ada', 'has space', 'a']) {
        await assert.rejects(addUser(username, 'student'), { constraint: 'username_format' }, username);
      }
    });

    it('refuse a duplicate username', async () => {
      await assert.rejects(addUser('ada', 'student'), { constraint: 'users_username_key' });
    });
  });

  describe('deleting', () => {
    it('a student removes their tickets', async () => {
      await pool.query('DELETE FROM users WHERE id = $1', [ids.ada]);
      assert.equal((await one('SELECT COUNT(*)::int AS n FROM tickets WHERE student_id = $1', [ids.ada])).n, 0);
    });

    it('a TA keeps their finished sessions, minus the name', async () => {
      await pool.query('DELETE FROM users WHERE id = $1', [ids.ta]);
      const history = await pool.query("SELECT helper_id FROM tickets WHERE status = 'done'");
      assert.equal(history.rows.length, 3);
      assert.ok(history.rows.every((row) => row.helper_id === null));
    });

    it('a TA in the middle of helping someone is refused', async () => {
      // This is why the API puts that student back in line before deleting.
      await pool.query(
        "UPDATE tickets SET status = 'helping', helper_id = $1, claimed_at = NOW() WHERE student_id = $2 AND queue_id = $3",
        [ids.ta, ids.grace, ids.q330]
      );
      await refusedBy('helping_has_helper', 'DELETE FROM users WHERE id = $1', [ids.ta]);
    });

    it('a queue that still has TAs is refused', async () => {
      await refusedBy('users_queue_id_fkey', 'DELETE FROM queues WHERE id = $1', [ids.q330]);
    });
  });
});
