# Office Hours Queue

A full-stack help queue for office hours: an HTML/CSS/JS frontend, a Node + Express API, and Postgres. Built as the counterpart to the [parking example](https://github.com/wmacevoy/languages-wmacevoy-fall-2026/tree/main/parking), with the same architecture and an automated test suite that runs on every push.

- **Students** see every queue, how many people are waiting and roughly how long it will take, then get in line with a short description of what they need. Their "ticket" shows their place in line and updates by itself.
- **TAs** run the desk for their course: take the next student, finish the session, open or close the queue.
- **Admins** open or close any queue and add or remove accounts.
- **Guests** (not signed in) see the board only. Students can create their own accounts; TAs and admins are created by an admin.

## Quick start (Docker)

```sh
docker compose down -v
docker compose up --build
```

Then open http://localhost:3000.

## Demo accounts

| Username | Password | Can do |
| --- | --- | --- |
| `root` | `rootpass` | Everything (student, TA for every queue, admin) |
| `ta/330` | `tapass123` | TA for CSCI 330 |
| `ada`, `grace`, `linus` | `studentpass` | Students |

The demo data starts with grace and ada waiting in CSCI 330, ada also waiting in CSCI 111, CSCI 250 closed, and three finished CSCI 330 sessions (6, 8 and 13 minutes) so the wait estimates have history to work from.

## API

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/health` | anyone | `{ ok: true }` when the database answers |
| `GET /api/queues` | anyone | Every queue with `waiting`, `helping`, `avg_help_minutes`, `est_wait_minutes` |
| `GET /api/queues/:id` | anyone | One queue |
| `POST /api/register` | anyone | Create a student account; returns a JWT. Body: `{ username, password }` |
| `POST /api/login` | anyone | Returns a JWT. Body: `{ username, password }` |
| `GET /api/me` | anyone | The signed-in user, or `null` |
| `POST /api/queues/:id/tickets` | student | Get in line. Body: `{ topic }` |
| `GET /api/my/tickets` | signed in | Your active tickets, with `position` and `est_wait_minutes` |
| `POST /api/tickets/:id/cancel` | that ticket's student | Leave the line |
| `GET /api/queues/:id/tickets` | that queue's TA, admin | Everyone in line, with names and topics |
| `POST /api/queues/:id/claim` | that queue's TA | Take the next student (first come, first served) |
| `POST /api/tickets/:id/finish` | the TA helping, admin | Mark the session done |
| `POST /api/queues/:id/open`, `/close` | that queue's TA, admin | Open or close the queue |
| `GET /api/users` | admin | List accounts |
| `POST /api/users` | admin | Add an account. Body: `{ username, password, role, queue_id }` (`queue_id` for TAs) |
| `DELETE /api/users/:id` | admin | Delete an account. Anyone a deleted TA was helping goes back to the front of the line |

Send the token as `Authorization: Bearer <token>`. Errors are JSON: `{ "error": "..." }`, with 400 for invalid input, 401 when not signed in, 403 when signed in but not allowed, 404 for something missing, and 409 for a conflict (already in line, queue closed, already helping someone).

## How the layers split the work

Each layer is written in the language that suits its job, the split described in chapter 9 of the course field guide:

- **SQL decides what states are valid** (`server/sql/init.sql`). A ticket is a small state machine (`waiting -> helping -> done`, or `waiting -> canceled`), and CHECK constraints make impossible tickets unstorable: a waiting ticket with a helper, a finished ticket nobody claimed, a ticket finished before it was created. Partial unique indexes enforce the fairness rules: one active ticket per student per queue, and one student at a time per TA. Taking the next student uses `FOR UPDATE SKIP LOCKED`, so two TAs clicking at once always get two different students.
- **JavaScript decides what happens next** (`server/app.js`). Request handling is procedural; the business rules (validation, permissions, wait estimates) are pure functions in `server/logic.js`, which imports nothing and is unit-tested with fixed inputs. All SQL lives in `server/queries.js`, and every value is passed as a `$1`-style parameter, never spliced into the query text.
- **HTML and CSS describe the page** (`server/public/`). Form attributes (`required`, `minlength`, `pattern`) give instant feedback before anything is sent, and CSS classes (`.is-open`, `.is-closed`) decide how each state looks. The server repeats every check, because anyone can call the API without the page.

Two defenses against injected markup: the page only ever inserts server data as text (never `innerHTML`), and the server sends a Content-Security-Policy that blocks inline scripts even if markup did get through. JWTs only identify the user; their role is re-read from the database on each request, so deleting an account or changing a role takes effect immediately.

## Tests

```sh
docker compose up -d db          # Postgres on localhost:5432 with the demo data
cd server
npm ci
npm test                          # unit, database, API and audit tests
npx playwright install chromium   # once
npm run test:e2e                  # browser tests
```

The tests reset the database to the demo data before every test, so don't point them at data you want to keep. `npm run db:reset` does the same reset by hand.

| File | What it checks |
| --- | --- |
| `server/test/logic.test.js` | The pure business rules: validation, permissions, wait estimates. No database needed. |
| `server/test/schema.test.js` | Each constraint in `init.sql` rejects the invalid write it was written for, by name. |
| `server/test/api.test.js` | Every endpoint against a real server and database: each role's permissions, validation, expired and forged tokens, SQL and markup in inputs, and concurrency (eight TAs claiming at once never get the same student). |
| `server/test/audit.test.js` | Reads the source: every query is parameterized, the page never uses `innerHTML`, `index.html` has no inline scripts, and `logic.js` stays pure. |
| `server/e2e/queue.spec.js` | Real Chromium against the real stack: signing up, getting in line, a TA helping students in order, a student's ticket updating without a reload, markup displayed as text, admin account management. Fails on any browser console error, including Content-Security-Policy violations. |

## Continuous integration

`.github/workflows/officehours.yml` runs on every push or pull request that touches `officehours/`:

1. **test**: `npm test` against a Postgres service container, on Node 22 and Node 24.
2. **browser (end to end)**: the Playwright tests in Chromium. Runs only after **test** passes, and keeps the Playwright report if anything fails.
3. **docker compose**: `docker compose up --build --wait`, the same command as the quick start, then a smoke test inside the app container (`server/scripts/smoke.js`) and a check that the app shuts down cleanly when stopped.

## Layout

```
officehours/
  docker-compose.yml       Postgres + the app, for running and for CI
  server/
    index.js               reads the environment, starts the server
    app.js                 routes, authentication, error handling
    queries.js             every SQL statement the app runs
    logic.js               pure business rules
    auth.js                JWT signing and checking
    db.js                  connection pool and transactions
    sql/init.sql           schema, constraints, demo data
    public/                index.html, app.js, styles.css
    scripts/               reset-db.js, smoke.js
    test/                  node:test suites
    e2e/                   Playwright browser tests
.github/workflows/officehours.yml
```

## Claude prompt

Built with Claude (Anthropic) from this request:

> I have a homework assignment to do a fullstack development for my class. I must use AI to accomplish this. "Instructions: Using the parking example as a reference, make a comparable full stack web application using Postgress, Node, JS/HTML/CSS. The application must have continuous testing via GitHub actions." Here is the link to his Github about parking: https://github.com/wmacevoy/languages-wmacevoy-fall-2026/tree/main/parking

When Claude offered a laundry tracker, a library checkout, or an office-hours help queue as the theme, the office-hours help queue was chosen.
