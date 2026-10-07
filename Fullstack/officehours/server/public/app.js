'use strict';

// Office Hours Queue: browser code.
//
// All data from the server reaches the page as text nodes (append / textContent),
// never parsed as HTML, so a topic like "<img src=x onerror=...>" can only ever
// display as those characters. test/audit.test.js fails the build if innerHTML
// shows up in this file.

const $ = (selector) => document.querySelector(selector);

const els = {
  sessionLabel: $('#session-label'),
  logout: $('#logout'),
  lastUpdated: $('#last-updated'),
  refresh: $('#refresh'),
  queueList: $('#queue-list'),
  side: $('#side'),

  authPanel: $('#auth-panel'),
  authTitle: $('#auth-title'),
  loginForm: $('#login-form'),
  registerForm: $('#register-form'),
  authSwitch: $('#auth-switch'),
  authStatus: $('#auth-status'),

  studentPanel: $('#student-panel'),
  myTickets: $('#my-tickets'),
  joinForm: $('#join-form'),
  joinQueue: $('#join-queue'),
  joinTopic: $('#join-topic'),
  joinHint: $('#join-hint'),
  studentStatus: $('#student-status'),

  taPanel: $('#ta-panel'),
  taQueue: $('#ta-queue'),
  nowHelping: $('#now-helping'),
  claimNext: $('#claim-next'),
  toggleOpen: $('#toggle-open'),
  claimHint: $('#claim-hint'),
  waitingList: $('#waiting-list'),
  taStatus: $('#ta-status'),

  adminPanel: $('#admin-panel'),
  userForm: $('#user-form'),
  userRole: $('#user-role'),
  userQueueRow: $('#user-queue-row'),
  userQueue: $('#user-queue'),
  userList: $('#user-list'),
  userStatus: $('#user-status'),
};

// localStorage can be unavailable (private windows, blocked storage); the app
// still works, you just sign in again next visit.
const storage = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not persisted */
    }
  },
  remove: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing stored */
    }
  },
};

const TOKEN_KEY = 'officehours_token';

const state = {
  token: storage.get(TOKEN_KEY),
  user: null,
  queues: [],
  myTickets: [],
  staffTickets: [],
  users: [],
  lastRefresh: null,
  newTicketId: null,
};

// These decide what to *show*. What a user may actually *do* is decided by the
// server on every request (logic.js), whatever this page shows or hides.
const can = {
  join: (user) => Boolean(user && (user.is_root || user.role === 'student')),
  staff: (user) => Boolean(user && (user.is_root || user.role === 'admin' || user.role === 'ta')),
  help: (user, queueId) =>
    Boolean(user && (user.is_root || (user.role === 'ta' && user.queue_id === queueId))),
  admin: (user) => Boolean(user && (user.is_root || user.role === 'admin')),
};

// ---------------------------------------------------------------------------
// DOM building. h('p', { class: 'x' }, 'text', child) makes <p class="x">.
// Children that are strings or numbers become text nodes, never markup.

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};

// Rebuild a <select> only when its choices actually changed, so the 5-second
// refresh doesn't reset what someone has picked or yank an open dropdown shut.
const setOptions = (select, options) => {
  const signature = JSON.stringify(options);
  if (select.dataset.signature === signature) return;
  const previous = select.value;
  select.replaceChildren(
    ...options.map((option) =>
      h('option', { value: option.value, disabled: option.disabled }, option.label)
    )
  );
  select.dataset.signature = signature;
  const keep = options.find((option) => option.value === previous && !option.disabled);
  const first = options.find((option) => !option.disabled);
  select.value = (keep ?? first ?? options[0])?.value ?? '';
};

const say = (element, message, kind = 'info') => {
  element.textContent = message;
  element.dataset.kind = kind;
};

// ---------------------------------------------------------------------------
// Formatting.

const ordinal = (n) => {
  const suffixes = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
  return `${n}${suffixes[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(n)]}`;
};
const clock = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const minutesSince = (value) => Math.max(0, Math.round((Date.now() - new Date(value)) / 60000));
const roleName = (user) =>
  user.is_root ? 'all roles' : { student: 'student', ta: 'TA', admin: 'admin' }[user.role] ?? user.role;
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Talking to the API.

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const api = async (method, url, body) => {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    // A 401 while signed in means the account or token is no longer valid.
    if (response.status === 401 && state.token) signOut('Your session ended. Sign in again.');
    throw new ApiError(data?.error ?? `Request failed (${response.status})`, response.status);
  }
  return data;
};

const staffQueueId = () => {
  const { user } = state;
  if (!can.staff(user)) return null;
  if (user.role === 'ta' && !user.is_root) return user.queue_id;
  return Number(els.taQueue.value) || state.queues[0]?.id || null;
};

const loadEverything = async () => {
  const { user } = state;
  const [queues, myTickets, users] = await Promise.all([
    api('GET', '/api/queues'),
    can.join(user) ? api('GET', '/api/my/tickets') : [],
    can.admin(user) ? api('GET', '/api/users') : [],
  ]);
  state.queues = queues;
  state.myTickets = myTickets;
  state.users = users;

  // Which queue the desk shows can depend on the queue list just loaded.
  const deskQueue = staffQueueId();
  state.staffTickets = deskQueue ? await api('GET', `/api/queues/${deskQueue}/tickets`) : [];
  state.lastRefresh = new Date();
};

// One refresh at a time. If one is already running, it may have read the data
// before whatever just changed, so queue exactly one more to run after it.
let inFlight = null;
let queued = null;
const refresh = () => {
  if (inFlight) {
    queued ??= inFlight.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }
  inFlight = loadEverything()
    .then(() => render())
    .catch((err) => {
      say(els.lastUpdated, `Couldn't refresh: ${err.message}`, 'error');
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

// ---------------------------------------------------------------------------
// Rendering.

const render = () => {
  renderSession();
  renderBoard();
  renderStudent();
  renderDesk();
  renderPeople();
};

const renderSession = () => {
  const { user } = state;
  els.sessionLabel.hidden = !user;
  els.sessionLabel.textContent = user ? `Signed in as ${user.username} (${roleName(user)})` : '';
  els.logout.hidden = !user;
  els.authPanel.hidden = Boolean(user);
  els.studentPanel.hidden = !can.join(user);
  els.taPanel.hidden = !can.staff(user);
  els.adminPanel.hidden = !can.admin(user);
  els.side.hidden = els.authPanel.hidden && els.studentPanel.hidden;

  // The layout follows the job: staff get their desk first, students their ticket.
  document.body.dataset.view = !user ? 'guest' : can.join(user) ? 'student' : 'staff';
};

const waitPhrase = (queue) => {
  if (!queue.is_open) {
    return queue.waiting > 0
      ? 'Closed to new students. TAs are finishing the line.'
      : 'Closed right now.';
  }
  return queue.est_wait_minutes === 0
    ? 'No wait if you join now.'
    : `About ${queue.est_wait_minutes} min if you join now.`;
};

const queueRow = (queue) =>
  h(
    'li',
    { class: `queue ${queue.is_open ? 'is-open' : 'is-closed'}`, 'data-queue-id': queue.id },
    h(
      'div',
      { class: 'queue-main' },
      h('h3', { class: 'queue-name' }, queue.name),
      h(
        'p',
        { class: 'queue-where' },
        h('span', { class: 'queue-status' }, queue.is_open ? 'Open' : 'Closed'),
        h('span', { class: 'queue-location' }, queue.location)
      ),
      h('p', { class: 'queue-wait' }, waitPhrase(queue)),
      queue.is_open || queue.helping > 0
        ? h(
            'p',
            { class: 'queue-pace' },
            `${plural(queue.helping, 'student', 'students')} being helped. Sessions run about ${queue.avg_help_minutes} min.`
          )
        : null
    ),
    h(
      'p',
      { class: 'queue-count' },
      h('span', { class: 'queue-count-number' }, queue.waiting),
      h('span', { class: 'queue-count-label' }, 'waiting')
    )
  );

const renderBoard = () => {
  if (state.lastRefresh) say(els.lastUpdated, `Updated ${clock(state.lastRefresh)}`);
  els.queueList.replaceChildren(...state.queues.map(queueRow));
};

const ticketStub = (ticket) => {
  const isNew = ticket.id === state.newTicketId;
  if (ticket.status === 'helping') {
    const queue = state.queues.find((q) => q.id === ticket.queue_id);
    return h(
      'article',
      { class: 'ticket is-now', 'data-ticket-id': ticket.id },
      h('p', { class: 'ticket-number' }, 'Now'),
      h(
        'div',
        { class: 'ticket-body' },
        h('p', { class: 'ticket-headline' }, `${ticket.helper ?? 'A TA'} is helping you.`),
        queue ? h('p', { class: 'ticket-wait' }, `Head to ${queue.location}.`) : null,
        h('p', { class: 'ticket-topic' }, ticket.topic)
      )
    );
  }
  return h(
    'article',
    { class: `ticket${isNew ? ' is-new' : ''}`, 'data-ticket-id': ticket.id },
    h('p', { class: 'ticket-number', 'aria-label': `Number ${ticket.position} in line` }, ticket.position),
    h(
      'div',
      { class: 'ticket-body' },
      h('p', { class: 'ticket-headline' }, `${ordinal(ticket.position)} in line for ${ticket.queue_name}`),
      h(
        'p',
        { class: 'ticket-wait' },
        ticket.est_wait_minutes === 0 ? "You're next." : `About ${ticket.est_wait_minutes} min.`
      ),
      h('p', { class: 'ticket-topic' }, ticket.topic),
      h(
        'button',
        { class: 'button button--quiet', type: 'button', 'data-cancel': ticket.id },
        'Leave the line'
      )
    )
  );
};

const renderStudent = () => {
  if (els.studentPanel.hidden) return;

  els.myTickets.replaceChildren(
    ...(state.myTickets.length > 0
      ? state.myTickets.map(ticketStub)
      : [h('p', { class: 'empty' }, "You're not in line anywhere. Pick a queue below.")])
  );
  state.newTicketId = null; // play the "ticket dispensed" motion only once

  const inLine = new Set(state.myTickets.map((ticket) => ticket.queue_id));
  const open = state.queues.filter((queue) => queue.is_open);
  setOptions(
    els.joinQueue,
    open.length > 0
      ? open.map((queue) => ({
          value: String(queue.id),
          label: inLine.has(queue.id) ? `${queue.name} (you're in line)` : queue.name,
          disabled: inLine.has(queue.id),
        }))
      : [{ value: '', label: 'No queues are open right now', disabled: true }]
  );
  const canJoinOne = open.some((queue) => !inLine.has(queue.id));
  els.joinForm.querySelector('button').disabled = !canJoinOne;
  els.joinHint.hidden = canJoinOne;
  els.joinHint.textContent =
    open.length === 0 ? 'When a TA opens a queue, you can get in line here.' : "You're in line for every open queue.";
};

const helpingCard = (ticket, user) => {
  const mine = ticket.helper_id === user.id;
  return h(
    'div',
    { class: `helping${mine ? ' is-mine' : ''}`, 'data-ticket-id': ticket.id },
    h('p', { class: 'helping-who' }, mine ? `You're helping ${ticket.student}` : `${ticket.helper} is helping ${ticket.student}`),
    h('p', { class: 'helping-topic' }, ticket.topic),
    h('p', { class: 'helping-since' }, `Since ${clock(ticket.claimed_at)}`),
    mine || can.admin(user)
      ? h('button', { class: 'button button--primary', type: 'button', 'data-finish': ticket.id }, 'Finish')
      : null
  );
};

const waitingItem = (ticket) =>
  h(
    'li',
    { class: 'waiting-item', 'data-ticket-id': ticket.id },
    h('span', { class: 'waiting-position' }, ticket.position),
    h(
      'span',
      { class: 'waiting-text' },
      h('span', { class: 'waiting-student' }, ticket.student),
      h('span', { class: 'waiting-topic' }, ticket.topic)
    ),
    h('span', { class: 'waiting-since' }, `${minutesSince(ticket.created_at)} min`)
  );

const renderDesk = () => {
  if (els.taPanel.hidden) return;
  const { user } = state;

  // A TA works one queue; admins and root can look at any of them.
  const choices =
    user.role === 'ta' && !user.is_root
      ? state.queues.filter((queue) => queue.id === user.queue_id)
      : state.queues;
  setOptions(els.taQueue, choices.map((queue) => ({ value: String(queue.id), label: queue.name })));
  els.taQueue.disabled = choices.length <= 1;

  const queueId = staffQueueId();
  const queue = state.queues.find((q) => q.id === queueId);
  const sessions = state.staffTickets.filter((ticket) => ticket.status === 'helping');
  const waiting = state.staffTickets.filter((ticket) => ticket.status === 'waiting');
  const current = sessions.find((ticket) => ticket.helper_id === user.id);
  const helper = can.help(user, queueId);

  els.toggleOpen.hidden = !queue;
  els.toggleOpen.textContent = queue?.is_open ? 'Close queue' : 'Open queue';
  els.toggleOpen.dataset.action = queue?.is_open ? 'close' : 'open';
  els.claimNext.hidden = !helper;
  els.claimNext.disabled = Boolean(current) || waiting.length === 0;
  els.claimHint.hidden = !(helper && current && waiting.length > 0);
  els.claimHint.textContent = current ? `Finish with ${current.student} to take the next student.` : '';

  let note = null;
  if (helper && !current) {
    note = waiting.length > 0 ? 'Take the next student when you are free.' : 'Nobody is waiting.';
  } else if (!helper && sessions.length === 0) {
    note = 'Nobody is being helped right now.';
  }
  els.nowHelping.replaceChildren(
    ...sessions.map((ticket) => helpingCard(ticket, user)),
    ...(note ? [h('p', { class: 'empty' }, note)] : [])
  );
  els.waitingList.replaceChildren(
    ...(waiting.length > 0 ? waiting.map(waitingItem) : [h('li', { class: 'empty' }, 'The line is empty.')])
  );
};

const renderPeople = () => {
  if (els.adminPanel.hidden) return;
  setOptions(els.userQueue, state.queues.map((queue) => ({ value: String(queue.id), label: queue.name })));
  els.userList.replaceChildren(
    ...state.users.map((person) =>
      h(
        'tr',
        { 'data-user-id': person.id },
        h('td', {}, person.username),
        h('td', {}, roleName(person)),
        h('td', {}, person.queue_name ?? ''),
        h(
          'td',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'button button--danger',
              type: 'button',
              'data-delete': person.id,
              'data-username': person.username,
              'aria-label': `Delete ${person.username}`,
              disabled: person.is_root || person.id === state.user.id,
            },
            'Delete'
          )
        )
      )
    )
  );
};

// ---------------------------------------------------------------------------
// Sessions.

const setSession = ({ token, user }) => {
  state.token = token;
  state.user = user;
  storage.set(TOKEN_KEY, token);
  els.loginForm.reset();
  els.registerForm.reset();
  say(els.authStatus, '');
  render();
  return refresh();
};

const signOut = (message) => {
  Object.assign(state, { token: null, user: null, myTickets: [], staffTickets: [], users: [] });
  storage.remove(TOKEN_KEY);
  render();
  say(els.authStatus, message);
};

const showRegister = (register) => {
  els.loginForm.hidden = register;
  els.registerForm.hidden = !register;
  els.authTitle.textContent = register ? 'Create an account' : 'Sign in';
  els.authSwitch.textContent = register ? 'Have an account? Sign in' : 'New here? Create a student account';
  say(els.authStatus, '');
};

// Run an action, refresh the page data, then report the outcome in `statusEl`
// -- in that order, so "Deleted ta/111." never sits next to a list that still
// shows ta/111.
const act = async (statusEl, work) => {
  try {
    const message = await work();
    await refresh();
    if (message) say(statusEl, message);
  } catch (err) {
    say(statusEl, err.message, 'error');
  }
};

// ---------------------------------------------------------------------------
// Events.

els.refresh.addEventListener('click', () => refresh());

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await setSession(
      await api('POST', '/api/login', {
        username: $('#login-username').value,
        password: $('#login-password').value,
      })
    );
  } catch (err) {
    say(els.authStatus, err.message, 'error');
  }
});

els.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await setSession(
      await api('POST', '/api/register', {
        username: $('#register-username').value,
        password: $('#register-password').value,
      })
    );
  } catch (err) {
    say(els.authStatus, err.message, 'error');
  }
});

els.authSwitch.addEventListener('click', () => showRegister(els.registerForm.hidden));
els.logout.addEventListener('click', () => signOut('Signed out.'));

els.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  act(els.studentStatus, async () => {
    const ticket = await api('POST', `/api/queues/${els.joinQueue.value}/tickets`, {
      topic: els.joinTopic.value,
    });
    state.newTicketId = ticket.id;
    els.joinTopic.value = '';
    return `You're ${ordinal(ticket.position)} in line.`;
  });
});

els.myTickets.addEventListener('click', (event) => {
  const button = event.target.closest('[data-cancel]');
  if (!button) return;
  act(els.studentStatus, async () => {
    await api('POST', `/api/tickets/${button.dataset.cancel}/cancel`);
    return 'You left the line.';
  });
});

els.taQueue.addEventListener('change', () => {
  say(els.taStatus, '');
  refresh();
});

els.claimNext.addEventListener('click', () => {
  act(els.taStatus, async () => {
    const ticket = await api('POST', `/api/queues/${staffQueueId()}/claim`);
    return `You're helping ${ticket.student}.`;
  });
});

els.nowHelping.addEventListener('click', (event) => {
  const button = event.target.closest('[data-finish]');
  if (!button) return;
  act(els.taStatus, async () => {
    const ticket = await api('POST', `/api/tickets/${button.dataset.finish}/finish`);
    return `Finished with ${ticket.student}.`;
  });
});

els.toggleOpen.addEventListener('click', () => {
  const action = els.toggleOpen.dataset.action;
  act(els.taStatus, async () => {
    const queue = await api('POST', `/api/queues/${staffQueueId()}/${action}`);
    return queue.is_open ? `${queue.name} is open.` : `${queue.name} is closed.`;
  });
});

els.userRole.addEventListener('change', () => {
  els.userQueueRow.hidden = els.userRole.value !== 'ta';
});

els.userForm.addEventListener('submit', (event) => {
  event.preventDefault();
  act(els.userStatus, async () => {
    const role = els.userRole.value;
    const person = await api('POST', '/api/users', {
      username: $('#user-username').value,
      password: $('#user-password').value,
      role,
      queue_id: role === 'ta' ? Number(els.userQueue.value) : null,
    });
    els.userForm.reset();
    els.userQueueRow.hidden = true;
    return `Added ${person.username}.`;
  });
});

els.userList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete]');
  if (!button) return;
  // eslint-disable-next-line no-alert -- a native dialog is the simplest accessible confirm
  if (!window.confirm(`Delete ${button.dataset.username}? This can't be undone.`)) return;
  act(els.userStatus, async () => {
    const removed = await api('DELETE', `/api/users/${button.dataset.delete}`);
    return removed.requeued > 0
      ? `Deleted ${removed.username}. ${plural(removed.requeued, 'student', 'students')} went back to the front of the line.`
      : `Deleted ${removed.username}.`;
  });
});

// ---------------------------------------------------------------------------
// Start: restore a saved session, load, then keep the board fresh.

const boot = async () => {
  if (state.token) {
    try {
      const { user } = await api('GET', '/api/me');
      if (user) state.user = user;
      else signOut('Your session ended. Sign in again.');
    } catch {
      signOut('Your session ended. Sign in again.');
    }
  }
  render();
  await refresh();
};

boot();
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
