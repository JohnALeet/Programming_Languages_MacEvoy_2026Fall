'use strict';

// Pure functions only: no database, no clock, no request objects. Everything a
// function needs arrives as an argument and nothing is mutated, so each rule
// here can be tested with fixed inputs (test/logic.test.js) -- the "pure
// function" argument from the field guide's section 9.3, applied to this app.

const DEFAULT_HELP_MINUTES = 10; // guess for a queue with no history yet
const RECENT_SAMPLE = 10; // how many recent sessions the average looks at
const TOPIC_MAX = 200; // must match the topic_length CHECK in sql/init.sql
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything past 72 bytes
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9/._-]{1,31}$/; // same as username_format
const ROLES = Object.freeze(['student', 'ta', 'admin']);
const MAX_INT = 2147483647; // Postgres INTEGER

// ---------------------------------------------------------------------------
// Validation. Each validator returns { value } or { error }, never throws.
// The browser checks some of this too, for quick feedback, but anyone can call
// the API without the browser -- these are the checks that actually count.

// Route parameters arrive as strings. Accept only plain positive integers that
// fit in a Postgres INTEGER, so "7abc", "1e3" or "99999999999" never reach SQL.
const parseId = (value) =>
  /^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= MAX_INT ? Number(value) : null;

// Postgres char_length counts code points; JavaScript's .length counts UTF-16
// units (an emoji is 2). Counting code points keeps both layers in agreement.
const charLength = (text) => Array.from(text).length;

const normalizeTopic = (text) => text.replace(/\s+/g, ' ').trim();

const validateTopic = (input) => {
  if (typeof input !== 'string') return { error: 'Topic must be text' };
  const topic = normalizeTopic(input);
  if (topic.length === 0) return { error: 'Say what you need help with' };
  if (charLength(topic) > TOPIC_MAX) {
    return { error: `Keep the topic to ${TOPIC_MAX} characters or fewer` };
  }
  return { value: topic };
};

const normalizeUsername = (input) => (typeof input === 'string' ? input.trim().toLowerCase() : '');

const validateUsername = (input) => {
  const username = normalizeUsername(input);
  if (!USERNAME_PATTERN.test(username)) {
    return {
      error: 'Username must be 2-32 characters: lowercase letters, digits, and . _ - /',
    };
  }
  return { value: username };
};

const validatePassword = (input) => {
  if (typeof input !== 'string' || input.length < PASSWORD_MIN) {
    return { error: `Password must be at least ${PASSWORD_MIN} characters` };
  }
  if (new TextEncoder().encode(input).length > PASSWORD_MAX_BYTES) {
    return { error: 'Password is too long' };
  }
  return { value: input };
};

// What an admin may create: a role, plus a queue only when the role is TA.
const validateRole = (role = 'student', queueId = null) => {
  if (!ROLES.includes(role)) return { error: 'Role must be student, ta or admin' };
  if (role !== 'ta') return { value: { role, queueId: null } };
  const id = parseId(queueId);
  if (id === null) return { error: 'A TA needs a queue' };
  return { value: { role, queueId: id } };
};

// ---------------------------------------------------------------------------
// Permissions. The root account holds every role, as in the parking example.

const isAdmin = (user) => Boolean(user && (user.is_root || user.role === 'admin'));
const isStudent = (user) => Boolean(user && (user.is_root || user.role === 'student'));
const isTaFor = (user, queueId) =>
  Boolean(user && (user.is_root || (user.role === 'ta' && user.queue_id === queueId)));

// Open/close a queue and see who is in it (names and topics).
const canStaffQueue = (user, queueId) => isAdmin(user) || isTaFor(user, queueId);
// Take the next student.
const canHelpQueue = (user, queueId) => isTaFor(user, queueId);
// Mark a session finished: the TA who claimed it, or an admin cleaning up.
const canFinishTicket = (user, ticket) =>
  isAdmin(user) || Boolean(user && ticket.helper_id === user.id);

// ---------------------------------------------------------------------------
// Wait estimates.

const minutesBetween = (start, end) => (new Date(end) - new Date(start)) / 60000;

// Mean length of the most recent finished sessions. A pipeline -- filter,
// order, take, measure, sum -- with no mutable accumulator.
const averageHelpMinutes = (
  finished,
  { fallback = DEFAULT_HELP_MINUTES, sample = RECENT_SAMPLE } = {}
) => {
  const durations = finished
    .filter((ticket) => ticket.claimed_at && ticket.finished_at)
    .toSorted((a, b) => new Date(b.finished_at) - new Date(a.finished_at))
    .slice(0, sample)
    .map((ticket) => minutesBetween(ticket.claimed_at, ticket.finished_at));

  return durations.length === 0
    ? fallback
    : durations.reduce((total, minutes) => total + minutes, 0) / durations.length;
};

// Someone with `ahead` people in front of them, served by `helpers` TAs who
// each take `avgHelpMinutes` per student. When nobody is mid-session we still
// assume one TA, rather than promising an infinite or zero wait.
const estimateWaitMinutes = ({ ahead, avgHelpMinutes, helpers }) =>
  ahead <= 0 ? 0 : Math.ceil((ahead * avgHelpMinutes) / Math.max(1, helpers));

// Pure from the outside -- same input, same Map out, input untouched -- while
// using ordinary mutation inside, the "black-box functional" idea of section 4.6.
const groupBy = (items, keyOf) => {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
};

// Decorate a queue row (from SQL) with the numbers the board shows.
const summarizeQueue = (queue, finished) => {
  const avgHelpMinutes = averageHelpMinutes(finished);
  return {
    ...queue,
    avg_help_minutes: Math.round(avgHelpMinutes),
    // A closed queue takes no one new, so "how long if I join now" has no answer.
    est_wait_minutes: queue.is_open
      ? estimateWaitMinutes({ ahead: queue.waiting, avgHelpMinutes, helpers: queue.helping })
      : null,
  };
};

// Decorate one of a student's own tickets with their place in line.
const describeTicket = (ticket, finished, helpers) => {
  if (ticket.status !== 'waiting') return { ...ticket, position: null, est_wait_minutes: null };
  return {
    ...ticket,
    position: ticket.ahead + 1,
    est_wait_minutes: estimateWaitMinutes({
      ahead: ticket.ahead,
      avgHelpMinutes: averageHelpMinutes(finished),
      helpers,
    }),
  };
};

module.exports = {
  DEFAULT_HELP_MINUTES,
  RECENT_SAMPLE,
  TOPIC_MAX,
  PASSWORD_MIN,
  ROLES,
  parseId,
  charLength,
  normalizeTopic,
  validateTopic,
  normalizeUsername,
  validateUsername,
  validatePassword,
  validateRole,
  isAdmin,
  isStudent,
  isTaFor,
  canStaffQueue,
  canHelpQueue,
  canFinishTicket,
  minutesBetween,
  averageHelpMinutes,
  estimateWaitMinutes,
  groupBy,
  summarizeQueue,
  describeTicket,
};
