'use strict';

// The whole stack through a real browser: Chromium -> HTML/CSS/JS -> Express
// -> Postgres. Each test starts from the demo data in sql/init.sql.

const { test: base, expect } = require('playwright/test');
const { createPool, resetDatabase, DATABASE_URL, PASSWORDS } = require('../test/helpers');

// Every test also fails if the browser logs an error: an exception, or a
// Content-Security-Policy violation. ("Failed to load resource" is just the
// browser noting a 4xx that a test provoked on purpose, like a wrong password.)
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        problems.push(message.text());
      }
    });
    await use(page);
    expect(problems, 'errors in the browser console').toEqual([]);
  },
});

let pool;
test.beforeAll(() => {
  pool = createPool(DATABASE_URL);
});
test.afterAll(() => pool.end());
test.beforeEach(() => resetDatabase(pool));

const queueRow = (page, course) => page.locator('.queue', { hasText: course });

const signIn = async (page, username, password = PASSWORDS[username]) => {
  await page.goto('/');
  const form = page.locator('#login-form');
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#session-label')).toContainText(`Signed in as ${username}`);
};

const signOut = (page) => page.getByRole('button', { name: 'Sign out' }).click();

test('a guest sees the live board and only the sign-in panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.queue')).toHaveCount(3);
  await expect(queueRow(page, 'CSCI 330').locator('.queue-count-number')).toHaveText('2');
  await expect(queueRow(page, 'CSCI 330')).toContainText('About 18 min if you join now.');
  await expect(queueRow(page, 'CSCI 250')).toContainText('Closed right now.');

  await expect(page.locator('#auth-panel')).toBeVisible();
  for (const panel of ['#student-panel', '#ta-panel', '#admin-panel']) {
    await expect(page.locator(panel)).toBeHidden();
  }
  await expect(page.locator('body')).not.toContainText(/\bnull\b|\bundefined\b|NaN/);
});

test('a new student signs up, gets in line, and leaves', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create a student account' }).click();
  const form = page.locator('#register-form');
  await form.getByLabel('Username').fill('hopper');
  await form.getByLabel('Password').fill('compilers!');
  await form.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#session-label')).toHaveText('Signed in as hopper (student)');
  await expect(page.locator('#my-tickets')).toContainText("You're not in line anywhere.");

  await page.locator('#join-form').getByLabel('Queue').selectOption({ label: 'CSCI 111: Intro to Programming' });
  await page.getByLabel('What do you need help with?').fill('Segfault in my linked list');
  await page.getByRole('button', { name: 'Get in line' }).click();

  const ticket = page.locator('.ticket');
  await expect(ticket.locator('.ticket-number')).toHaveText('2');
  await expect(ticket).toContainText('2nd in line for CSCI 111: Intro to Programming');
  await expect(ticket).toContainText('Segfault in my linked list');
  await expect(page.locator('#student-status')).toHaveText("You're 2nd in line.");
  await expect(queueRow(page, 'CSCI 111').locator('.queue-count-number')).toHaveText('2');

  await ticket.getByRole('button', { name: 'Leave the line' }).click();
  await expect(page.locator('#student-status')).toHaveText('You left the line.');
  await expect(page.locator('.ticket')).toHaveCount(0);
  await expect(queueRow(page, 'CSCI 111').locator('.queue-count-number')).toHaveText('1');
});

test('the browser checks the sign-up form before sending it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Create a student account' }).click();
  const form = page.locator('#register-form');
  await form.getByLabel('Username').fill('shorty');
  await form.getByLabel('Password').fill('short');

  let sent = false;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/register')) sent = true;
  });
  await form.getByRole('button', { name: 'Create account' }).click();

  // minlength="8" stops the submit in the browser; the server never hears of it.
  expect(await form.getByLabel('Password').evaluate((input) => input.validity.tooShort)).toBe(true);
  expect(sent).toBe(false);
  await expect(page.locator('#session-label')).toBeHidden();
});

test('a wrong password says so and stays signed out', async ({ page }) => {
  await page.goto('/');
  const form = page.locator('#login-form');
  await form.getByLabel('Username').fill('ada');
  await form.getByLabel('Password').fill('not-her-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#auth-status')).toHaveText('Wrong username or password');
  await expect(page.locator('#student-panel')).toBeHidden();
});

test('a saved session that no longer works is cleared', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('officehours_token', 'stale.token.value'));
  await page.goto('/');
  await expect(page.locator('#auth-status')).toHaveText('Your session ended. Sign in again.');
  await expect(page.locator('#auth-panel')).toBeVisible();
});

test('a TA helps students first come, first served', async ({ page }) => {
  await signIn(page, 'ta/330');
  await expect(page.locator('#ta-panel')).toBeVisible();
  await expect(page.locator('#student-panel')).toBeHidden();
  await expect(page.locator('#admin-panel')).toBeHidden();

  const line = page.locator('#waiting-list .waiting-item');
  await expect(line).toHaveCount(2);
  await expect(line.nth(0)).toContainText('grace');
  await expect(line.nth(1)).toContainText('ada');

  await page.getByRole('button', { name: 'Help next student' }).click();
  await expect(page.locator('#now-helping')).toContainText("You're helping grace");
  await expect(page.getByRole('button', { name: 'Help next student' })).toBeDisabled();
  await expect(page.locator('#claim-hint')).toHaveText('Finish with grace to take the next student.');

  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.locator('#ta-status')).toHaveText('Finished with grace.');
  await expect(line).toHaveCount(1);

  await page.getByRole('button', { name: 'Help next student' }).click();
  await expect(page.locator('#now-helping')).toContainText("You're helping ada");
  await expect(page.locator('#waiting-list')).toContainText('The line is empty.');
});

test('a TA can close and reopen their queue', async ({ page }) => {
  await signIn(page, 'ta/330');
  await page.getByRole('button', { name: 'Close queue' }).click();
  await expect(page.locator('#ta-status')).toHaveText('CSCI 330: Programming Languages is closed.');
  await expect(queueRow(page, 'CSCI 330').locator('.queue-status')).toHaveText('Closed');

  await page.getByRole('button', { name: 'Open queue' }).click();
  await expect(queueRow(page, 'CSCI 330').locator('.queue-status')).toHaveText('Open');
});

test('a student sees the TA pick them up without reloading', async ({ browser }) => {
  const studentContext = await browser.newContext();
  const taContext = await browser.newContext();
  const student = await studentContext.newPage();
  const ta = await taContext.newPage();

  await signIn(student, 'grace');
  await expect(student.locator('.ticket').first()).toContainText('1st in line for CSCI 330');

  await signIn(ta, 'ta/330');
  await ta.getByRole('button', { name: 'Help next student' }).click();

  // The page refreshes itself every 5 seconds.
  const ticket = student.locator('.ticket.is-now');
  await expect(ticket).toContainText('ta/330 is helping you.', { timeout: 10_000 });
  await expect(ticket).toContainText('Head to Room 211.');

  await studentContext.close();
  await taContext.close();
});

test('markup in a topic is displayed as text and never runs', async ({ page }) => {
  const attack = `<img src=x onerror="document.body.dataset.pwned='yes'"><b>bold?</b>`;

  await signIn(page, 'linus');
  await page.locator('#join-form').getByLabel('Queue').selectOption({ label: 'CSCI 330: Programming Languages' });
  await page.getByLabel('What do you need help with?').fill(attack);
  await page.getByRole('button', { name: 'Get in line' }).click();
  await expect(page.locator('.ticket-topic')).toHaveText(attack);
  await signOut(page);

  await signIn(page, 'ta/330');
  const item = page.locator('.waiting-item', { hasText: 'linus' });
  await expect(item.locator('.waiting-topic')).toHaveText(attack);
  // Displayed as characters: no <img> or <b> element was created from it...
  await expect(page.locator('#waiting-list img, #waiting-list b')).toHaveCount(0);
  // ...and nothing ran.
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});

test('root adds and removes a TA', async ({ page }) => {
  await signIn(page, 'root');
  await expect(page.locator('#admin-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete root' })).toBeDisabled();

  const form = page.locator('#user-form');
  await form.getByLabel('Username').fill('ta/111');
  await form.getByLabel('Password').fill('password123');
  await form.getByLabel('Role').selectOption('ta');
  await form.getByLabel('Queue').selectOption({ label: 'CSCI 111: Intro to Programming' });
  await form.getByRole('button', { name: 'Add person' }).click();

  await expect(page.locator('#user-status')).toHaveText('Added ta/111.');
  const row = page.locator('#user-list tr', { hasText: 'ta/111' });
  await expect(row).toContainText('CSCI 111: Intro to Programming');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete ta/111' }).click();
  await expect(page.locator('#user-status')).toHaveText('Deleted ta/111.');
  await expect(row).toHaveCount(0);
});
