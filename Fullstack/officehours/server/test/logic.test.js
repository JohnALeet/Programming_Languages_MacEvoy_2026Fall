'use strict';

// Unit tests for the pure business rules. No database, no server: every input
// is spelled out, so a failure points at exactly one function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../logic');

const at = (minutesAfterNine) => new Date(Date.UTC(2026, 9, 1, 9, minutesAfterNine)).toISOString();
const session = (claimedAt, finishedAt) => ({ claimed_at: at(claimedAt), finished_at: at(finishedAt) });

describe('parseId', () => {
  it('accepts plain positive integers', () => {
    assert.equal(logic.parseId('1'), 1);
    assert.equal(logic.parseId('42'), 42);
    assert.equal(logic.parseId(7), 7);
    assert.equal(logic.parseId('2147483647'), 2147483647);
  });

  it('rejects anything a Postgres INTEGER column would choke on', () => {
    for (const bad of ['0', '-1', '1.5', '1e3', '7abc', ' 7', '', 'NaN', '2147483648', '99999999999', null, undefined]) {
      assert.equal(logic.parseId(bad), null, `parseId(${JSON.stringify(bad)})`);
    }
  });
});

describe('validateTopic', () => {
  it('trims and collapses whitespace', () => {
    assert.deepEqual(logic.validateTopic('  closures\n\tvs   objects  '), { value: 'closures vs objects' });
  });

  it('rejects empty, blank and non-text topics', () => {
    assert.ok(logic.validateTopic('').error);
    assert.ok(logic.validateTopic('   \n ').error);
    assert.ok(logic.validateTopic(undefined).error);
    assert.ok(logic.validateTopic(42).error);
    assert.ok(logic.validateTopic({ $ne: '' }).error);
  });

  it('allows exactly TOPIC_MAX characters and no more', () => {
    assert.ok(logic.validateTopic('a'.repeat(logic.TOPIC_MAX)).value);
    assert.ok(logic.validateTopic('a'.repeat(logic.TOPIC_MAX + 1)).error);
  });

  it('counts characters the way Postgres does, not UTF-16 units', () => {
    // 200 emoji are 400 UTF-16 units but 200 characters to char_length().
    const emoji = '\u{1F41B}'.repeat(logic.TOPIC_MAX);
    assert.equal(emoji.length, 400);
    assert.equal(logic.charLength(emoji), 200);
    assert.ok(logic.validateTopic(emoji).value);
  });

  it('leaves markup alone -- escaping is the renderer\'s job, not the validator\'s', () => {
    const topic = '<img src=x onerror=alert(1)>';
    assert.deepEqual(logic.validateTopic(topic), { value: topic });
  });
});

describe('validateUsername', () => {
  it('normalizes case and surrounding space', () => {
    assert.deepEqual(logic.validateUsername('  Ada '), { value: 'ada' });
    assert.deepEqual(logic.validateUsername('ta/330'), { value: 'ta/330' });
  });

  it('rejects markup, spaces, and lengths outside 2-32', () => {
    for (const bad of ['<script>', 'a', 'has space', '-leading', 'x'.repeat(33), '', null, 7]) {
      assert.ok(logic.validateUsername(bad).error, `validateUsername(${JSON.stringify(bad)})`);
    }
  });
});

describe('validatePassword', () => {
  it('requires at least 8 characters', () => {
    assert.ok(logic.validatePassword('1234567').error);
    assert.deepEqual(logic.validatePassword('12345678'), { value: '12345678' });
  });

  it('rejects passwords bcrypt would silently truncate', () => {
    assert.ok(logic.validatePassword('x'.repeat(72)).value);
    assert.ok(logic.validatePassword('x'.repeat(73)).error);
    assert.ok(logic.validatePassword('é'.repeat(37)).error); // 74 bytes in UTF-8
  });

  it('rejects non-strings', () => {
    assert.ok(logic.validatePassword(12345678).error);
    assert.ok(logic.validatePassword(undefined).error);
  });
});

describe('validateRole', () => {
  it('defaults to student', () => {
    assert.deepEqual(logic.validateRole(), { value: { role: 'student', queueId: null } });
  });

  it('attaches a queue only to TAs', () => {
    assert.deepEqual(logic.validateRole('ta', '2'), { value: { role: 'ta', queueId: 2 } });
    assert.deepEqual(logic.validateRole('admin', '2'), { value: { role: 'admin', queueId: null } });
  });

  it('rejects unknown roles and TAs without a queue', () => {
    assert.ok(logic.validateRole('root').error);
    assert.ok(logic.validateRole('ta').error);
    assert.ok(logic.validateRole('ta', 'abc').error);
  });
});

describe('permissions', () => {
  const root = { id: 1, role: 'admin', is_root: true, queue_id: null };
  const admin = { id: 2, role: 'admin', is_root: false, queue_id: null };
  const ta = { id: 3, role: 'ta', is_root: false, queue_id: 2 };
  const student = { id: 4, role: 'student', is_root: false, queue_id: null };

  it('lets staff of a queue manage it, and only that queue', () => {
    assert.equal(logic.canStaffQueue(ta, 2), true);
    assert.equal(logic.canStaffQueue(ta, 1), false);
    assert.equal(logic.canStaffQueue(admin, 1), true);
    assert.equal(logic.canStaffQueue(student, 2), false);
    assert.equal(logic.canStaffQueue(null, 2), false);
  });

  it('lets only that queue\'s TAs (and root) take students', () => {
    assert.equal(logic.canHelpQueue(ta, 2), true);
    assert.equal(logic.canHelpQueue(ta, 1), false);
    assert.equal(logic.canHelpQueue(admin, 2), false);
    assert.equal(logic.canHelpQueue(root, 1), true);
  });

  it('lets students (and root) join queues', () => {
    assert.equal(logic.isStudent(student), true);
    assert.equal(logic.isStudent(ta), false);
    assert.equal(logic.isStudent(root), true);
    assert.equal(logic.isStudent(undefined), false);
  });

  it('lets the claiming TA or an admin finish a ticket', () => {
    assert.equal(logic.canFinishTicket(ta, { helper_id: 3 }), true);
    assert.equal(logic.canFinishTicket(ta, { helper_id: 99 }), false);
    assert.equal(logic.canFinishTicket(admin, { helper_id: 99 }), true);
    assert.equal(logic.canFinishTicket(student, { helper_id: 3 }), false);
  });
});

describe('averageHelpMinutes', () => {
  it('falls back to the default when a queue has no history', () => {
    assert.equal(logic.averageHelpMinutes([]), logic.DEFAULT_HELP_MINUTES);
    assert.equal(logic.averageHelpMinutes([], { fallback: 4 }), 4);
  });

  it('averages claim-to-finish durations', () => {
    assert.equal(logic.averageHelpMinutes([session(0, 6), session(10, 18), session(20, 33)]), 9);
  });

  it('ignores sessions missing a timestamp', () => {
    assert.equal(logic.averageHelpMinutes([session(0, 6), { claimed_at: at(1), finished_at: null }]), 6);
  });

  it('uses only the most recent sessions, whatever order they arrive in', () => {
    const old = session(0, 60); // a 60-minute session long ago
    const recent = [session(100, 104), session(110, 114)];
    assert.equal(logic.averageHelpMinutes([old, ...recent], { sample: 2 }), 4);
    assert.equal(logic.averageHelpMinutes([recent[1], old, recent[0]], { sample: 2 }), 4);
  });

  it('does not reorder or modify its input', () => {
    const input = [session(0, 6), session(10, 30)];
    const before = structuredClone(input);
    logic.averageHelpMinutes(input, { sample: 1 });
    assert.deepEqual(input, before);
  });
});

describe('estimateWaitMinutes', () => {
  it('is zero for the person at the front', () => {
    assert.equal(logic.estimateWaitMinutes({ ahead: 0, avgHelpMinutes: 9, helpers: 1 }), 0);
  });

  it('scales with the line and divides by the TAs working it', () => {
    assert.equal(logic.estimateWaitMinutes({ ahead: 2, avgHelpMinutes: 9, helpers: 1 }), 18);
    assert.equal(logic.estimateWaitMinutes({ ahead: 2, avgHelpMinutes: 9, helpers: 2 }), 9);
  });

  it('rounds up, never promising less than the arithmetic says', () => {
    assert.equal(logic.estimateWaitMinutes({ ahead: 1, avgHelpMinutes: 7.2, helpers: 1 }), 8);
  });

  it('assumes one TA when nobody is mid-session', () => {
    assert.equal(logic.estimateWaitMinutes({ ahead: 3, avgHelpMinutes: 5, helpers: 0 }), 15);
  });
});

describe('groupBy', () => {
  it('groups without touching the input', () => {
    const rows = [{ q: 1 }, { q: 2 }, { q: 1 }];
    const groups = logic.groupBy(rows, (row) => row.q);
    assert.deepEqual(groups.get(1), [{ q: 1 }, { q: 1 }]);
    assert.deepEqual(groups.get(2), [{ q: 2 }]);
    assert.equal(groups.get(3), undefined);
    assert.deepEqual(rows, [{ q: 1 }, { q: 2 }, { q: 1 }]);
  });
});

describe('summarizeQueue', () => {
  const history = [session(0, 6), session(10, 18), session(20, 33)];

  it('estimates the wait for someone joining now', () => {
    const summary = logic.summarizeQueue({ id: 2, is_open: true, waiting: 2, helping: 0 }, history);
    assert.equal(summary.avg_help_minutes, 9);
    assert.equal(summary.est_wait_minutes, 18);
    assert.equal(summary.id, 2, 'keeps the original fields');
  });

  it('gives no estimate for a closed queue', () => {
    const summary = logic.summarizeQueue({ id: 3, is_open: false, waiting: 0, helping: 0 }, []);
    assert.equal(summary.est_wait_minutes, null);
    assert.equal(summary.avg_help_minutes, logic.DEFAULT_HELP_MINUTES);
  });
});

describe('describeTicket', () => {
  it('turns "people ahead" into a position and an estimate', () => {
    const ticket = logic.describeTicket({ id: 9, status: 'waiting', ahead: 1 }, [session(0, 10)], 0);
    assert.equal(ticket.position, 2);
    assert.equal(ticket.est_wait_minutes, 10);
  });

  it('has no position once a TA has claimed it', () => {
    const ticket = logic.describeTicket({ id: 9, status: 'helping', ahead: 0 }, [], 1);
    assert.equal(ticket.position, null);
    assert.equal(ticket.est_wait_minutes, null);
  });
});
