'use strict';

// ---------------------------------------------------------------------------
// SQL. Every value reaches Postgres as a $n parameter, never spliced into the
// query text, so user input is always data and never syntax (field guide 9.6).
// test/audit.test.js fails the build if a query in this file contains ${...}.

const SQL = Object.freeze({
  userById: `
    SELECT id, username, role, queue_id, is_root
    FROM users
    WHERE id = $1`,

  login: `
    SELECT id, username, role, queue_id, is_root
    FROM users
    WHERE username = $1 AND password_hash = crypt($2, password_hash)`,

  // The role is written here, not read from the request: signing up can only
  // ever make a student, whatever extra fields the request body contains.
  register: `
    INSERT INTO users (username, password_hash, role)
    VALUES ($1, crypt($2, gen_salt('bf')), 'student')
    RETURNING id, username, role, queue_id, is_root`,

  // One row per queue with live counts. COUNT() returns a bigint, which
  // node-postgres delivers to JavaScript as a *string* (a bigint can exceed
  // what a JS number holds exactly). ::int converts it at the boundary, so the
  // API sends 2 rather than "2".
  queues: `
    SELECT q.id, q.name, q.location, q.is_open, q.updated_at,
           COUNT(t.id) FILTER (WHERE t.status = 'waiting')::int AS waiting,
           COUNT(t.id) FILTER (WHERE t.status = 'helping')::int AS helping
    FROM queues q
    LEFT JOIN tickets t ON t.queue_id = q.id AND t.status IN ('waiting', 'helping')
    WHERE $1::int IS NULL OR q.id = $1
    GROUP BY q.id
    ORDER BY q.id`,

  // The latest finished sessions of every queue, for the average help time.
  recentFinished: `
    SELECT queue_id, claimed_at, finished_at
    FROM (
      SELECT queue_id, claimed_at, finished_at,
             ROW_NUMBER() OVER (PARTITION BY queue_id ORDER BY finished_at DESC) AS recency
      FROM tickets
      WHERE status = 'done'
    ) AS recent
    WHERE recency <= $1`,

  setOpen: `
    UPDATE queues
    SET is_open = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING id`,

  queueExists: `
    SELECT id FROM queues WHERE id = $1`,

  // "The queue is open" and "add me" in one statement: there is no moment
  // between checking and inserting for someone to close the queue.
  join: `
    INSERT INTO tickets (queue_id, student_id, topic)
    SELECT id, $2, $3 FROM queues WHERE id = $1 AND is_open
    RETURNING id`,

  // A student's active tickets, each with how many people are ahead of it.
  // (created_at, id) < (created_at, id) compares row values left to right, so
  // two tickets created in the same instant still have a definite order.
  myTickets: `
    SELECT t.id, t.queue_id, q.name AS queue_name, t.topic, t.status,
           t.created_at, t.claimed_at, h.username AS helper,
           (SELECT COUNT(*)
            FROM tickets AS earlier
            WHERE earlier.queue_id = t.queue_id
              AND earlier.status = 'waiting'
              AND (earlier.created_at, earlier.id) < (t.created_at, t.id))::int AS ahead
    FROM tickets t
    JOIN queues q ON q.id = t.queue_id
    LEFT JOIN users h ON h.id = t.helper_id
    WHERE t.student_id = $1 AND t.status IN ('waiting', 'helping')
    ORDER BY t.created_at, t.id`,

  cancel: `
    UPDATE tickets
    SET status = 'canceled', finished_at = NOW()
    WHERE id = $1 AND student_id = $2 AND status = 'waiting'
    RETURNING id, queue_id, status`,

  // Everyone in one queue, for its staff: sessions in progress first, then
  // the line in order, numbered.
  queueTickets: `
    SELECT t.id, t.queue_id, t.topic, t.status, t.created_at, t.claimed_at,
           t.helper_id, s.username AS student, h.username AS helper,
           CASE WHEN t.status = 'waiting'
                THEN (ROW_NUMBER() OVER (PARTITION BY t.status ORDER BY t.created_at, t.id))::int
           END AS position
    FROM tickets t
    JOIN users s ON s.id = t.student_id
    LEFT JOIN users h ON h.id = t.helper_id
    WHERE t.queue_id = $1 AND t.status IN ('waiting', 'helping')
    ORDER BY t.status = 'waiting', t.created_at, t.id`,

  staffTicket: `
    SELECT t.id, t.queue_id, t.topic, t.status, t.created_at, t.claimed_at,
           t.finished_at, t.helper_id, s.username AS student, h.username AS helper
    FROM tickets t
    JOIN users s ON s.id = t.student_id
    LEFT JOIN users h ON h.id = t.helper_id
    WHERE t.id = $1`,

  // Take the person at the front of the line. Without a lock, two TAs clicking
  // at the same moment would both pick the same front row, and the second
  // UPDATE would overwrite the first TA's claim. FOR UPDATE locks the row this
  // query picked; SKIP LOCKED lets the other TA's query pass over that row and
  // take the next student, instead of queueing behind the lock.
  // test/api.test.js ("never hands the same student to two TAs") checks this.
  claimNext: `
    UPDATE tickets
    SET status = 'helping', helper_id = $2, claimed_at = NOW()
    WHERE id = (
      SELECT id FROM tickets
      WHERE queue_id = $1 AND status = 'waiting'
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`,

  ticketById: `
    SELECT id, queue_id, status, helper_id FROM tickets WHERE id = $1`,

  // The permission check is repeated in the WHERE clause so that checking and
  // writing happen atomically.
  finish: `
    UPDATE tickets
    SET status = 'done', finished_at = NOW()
    WHERE id = $1 AND status = 'helping' AND (helper_id = $2 OR $3::boolean)
    RETURNING id`,

  users: `
    SELECT u.id, u.username, u.role, u.queue_id, u.is_root, q.name AS queue_name
    FROM users u
    LEFT JOIN queues q ON q.id = u.queue_id
    ORDER BY u.id`,

  createUser: `
    INSERT INTO users (username, password_hash, role, queue_id)
    VALUES ($1, crypt($2, gen_salt('bf')), $3, $4)
    RETURNING id, username, role, queue_id, is_root`,

  lockUser: `
    SELECT id, username, is_root FROM users WHERE id = $1 FOR UPDATE`,

  // Students a departing TA was helping go back in line. Their created_at is
  // untouched, so they return to the front, not the back.
  requeueHelped: `
    UPDATE tickets
    SET status = 'waiting', helper_id = NULL, claimed_at = NULL
    WHERE helper_id = $1 AND status = 'helping'`,

  deleteUser: `
    DELETE FROM users WHERE id = $1`,
});

module.exports = { SQL };
