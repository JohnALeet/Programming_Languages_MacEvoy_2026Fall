-- Office Hours Queue: schema, constraints and demo data.
--
-- docker compose runs this once, on an empty database. The tests run it before
-- every test case, so it must also work when re-run (IF NOT EXISTS, ON CONFLICT).
--
-- The rules about which states are *valid* live here, as constraints, so no
-- code path -- the API, a psql session, a future script -- can store an
-- invalid queue. The JavaScript only decides which valid state comes next.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS queues (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  -- Lowercase letters, digits and . _ - / only. Besides keeping names tidy,
  -- this means a username can never contain markup like <script>.
  username TEXT NOT NULL UNIQUE
    CONSTRAINT username_format CHECK (username ~ '^[a-z0-9][a-z0-9/._-]{1,31}$'),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student'
    CONSTRAINT valid_role CHECK (role IN ('student', 'ta', 'admin')),
  -- No ON DELETE action: a queue that still has TAs cannot be deleted.
  queue_id INTEGER REFERENCES queues(id),
  is_root BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A TA works one queue; nobody else is attached to a queue at all.
  CONSTRAINT ta_has_queue CHECK ((role = 'ta') = (queue_id IS NOT NULL))
);

-- A ticket is one student asking for help. Its status is a small state machine:
--
--   waiting --claim--> helping --finish--> done
--      |
--      +----cancel---> canceled
--
-- Each status determines which of the other columns may be filled in, so the
-- database rejects impossible tickets (a waiting ticket with a helper, a
-- finished ticket nobody claimed, a ticket finished before it was created).
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stored already trimmed; 1-200 characters, counted the way Postgres counts.
  topic TEXT NOT NULL
    CONSTRAINT topic_length CHECK (char_length(topic) BETWEEN 1 AND 200 AND topic = btrim(topic)),
  status TEXT NOT NULL DEFAULT 'waiting'
    CONSTRAINT valid_status CHECK (status IN ('waiting', 'helping', 'done', 'canceled')),
  -- SET NULL keeps a finished ticket's history if its TA's account is deleted.
  -- (The API puts anyone a deleted TA was *currently* helping back in line first;
  -- helping_has_helper below would refuse the delete otherwise.)
  helper_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  CONSTRAINT waiting_is_untouched CHECK (
    status <> 'waiting' OR (helper_id IS NULL AND claimed_at IS NULL AND finished_at IS NULL)
  ),
  CONSTRAINT helping_has_helper CHECK (
    status <> 'helping' OR (helper_id IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NULL)
  ),
  CONSTRAINT done_was_helped CHECK (
    status <> 'done' OR (claimed_at IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT canceled_was_never_helped CHECK (
    status <> 'canceled' OR (claimed_at IS NULL AND finished_at IS NOT NULL)
  ),
  -- A NULL comparison is "unknown", which a CHECK accepts, so this only bites
  -- when both timestamps exist and are out of order.
  CONSTRAINT time_moves_forward CHECK (
    claimed_at >= created_at AND finished_at >= COALESCE(claimed_at, created_at)
  )
);

-- Partial unique indexes: uniqueness that applies only to *active* tickets.
-- A student can be in line once per queue (but keeps any number of old tickets)...
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ticket_per_student
  ON tickets (queue_id, student_id)
  WHERE status IN ('waiting', 'helping');

-- ...and a TA helps one student at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_student_per_helper
  ON tickets (helper_id)
  WHERE status = 'helping';

-- The first-come, first-served order that "who is next?" walks.
CREATE INDEX IF NOT EXISTS waiting_line
  ON tickets (queue_id, created_at, id)
  WHERE status = 'waiting';

-- ---------------------------------------------------------------------------
-- Demo data. Passwords are hashed by pgcrypto (bcrypt) and never stored plain.
-- gen_salt('bf') uses bcrypt's default cost to keep the test suite fast; a real
-- deployment would raise it, e.g. gen_salt('bf', 12).

INSERT INTO queues (name, location, is_open)
VALUES
  ('CSCI 111: Intro to Programming', 'Lab 104', TRUE),
  ('CSCI 330: Programming Languages', 'Room 211', TRUE),
  ('CSCI 250: Data Structures', 'Room 118', FALSE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO users (username, password_hash, role, is_root)
VALUES ('root', crypt('rootpass', gen_salt('bf')), 'admin', TRUE)
ON CONFLICT (username) DO NOTHING;

INSERT INTO users (username, password_hash, role, queue_id)
VALUES (
  'ta/330',
  crypt('tapass123', gen_salt('bf')),
  'ta',
  (SELECT id FROM queues WHERE name = 'CSCI 330: Programming Languages')
)
ON CONFLICT (username) DO NOTHING;

INSERT INTO users (username, password_hash, role)
VALUES
  ('ada', crypt('studentpass', gen_salt('bf')), 'student'),
  ('grace', crypt('studentpass', gen_salt('bf')), 'student'),
  ('linus', crypt('studentpass', gen_salt('bf')), 'student')
ON CONFLICT (username) DO NOTHING;

-- Tickets have no natural key to conflict on, so seed them only into an empty
-- table. Times are relative to NOW() so the demo always looks like "today".
-- linus's three finished sessions (6, 8 and 13 minutes) give CSCI 330 a
-- 9-minute average for the wait estimates.
INSERT INTO tickets (queue_id, student_id, topic, status, helper_id, created_at, claimed_at, finished_at)
SELECT q.id, s.id, seed.topic, seed.status,
       CASE WHEN seed.status = 'done' THEN h.id END,
       NOW() - seed.created_ago,
       NOW() - seed.claimed_ago,
       NOW() - seed.finished_ago
FROM (
  VALUES
    ('CSCI 330: Programming Languages', 'linus', 'Is Rust''s borrow checker a kind of type system?',
     'done', INTERVAL '95 minutes', INTERVAL '90 minutes', INTERVAL '84 minutes'),
    ('CSCI 330: Programming Languages', 'linus', 'Shift-reduce conflict in my grammar',
     'done', INTERVAL '80 minutes', INTERVAL '78 minutes', INTERVAL '70 minutes'),
    ('CSCI 330: Programming Languages', 'linus', 'Why is my reduce() returning NaN?',
     'done', INTERVAL '60 minutes', INTERVAL '45 minutes', INTERVAL '32 minutes'),
    ('CSCI 330: Programming Languages', 'grace', 'Why does my closure capture the last loop value?',
     'waiting', INTERVAL '12 minutes', NULL, NULL),
    ('CSCI 330: Programming Languages', 'ada', 'My recursive descent parser never terminates',
     'waiting', INTERVAL '5 minutes', NULL, NULL),
    ('CSCI 111: Intro to Programming', 'ada', 'Off-by-one error in a for loop',
     'waiting', INTERVAL '3 minutes', NULL, NULL)
) AS seed (queue_name, student, topic, status, created_ago, claimed_ago, finished_ago)
JOIN queues q ON q.name = seed.queue_name
JOIN users s ON s.username = seed.student
JOIN users h ON h.username = 'ta/330'
WHERE NOT EXISTS (SELECT 1 FROM tickets);
