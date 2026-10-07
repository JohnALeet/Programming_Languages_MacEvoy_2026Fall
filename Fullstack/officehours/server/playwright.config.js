'use strict';

// End-to-end tests: a real Chromium drives the real page, served by the real
// server (started below), backed by the real database. `npm run test:e2e`.

const { defineConfig, devices } = require('playwright/test');
const { DEFAULT_DATABASE_URL } = require('./scripts/reset-db');

const PORT = Number(process.env.E2E_PORT) || 3100;

module.exports = defineConfig({
  testDir: './e2e',
  // Every test resets the one shared database, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
      JWT_SECRET: 'e2e-only-secret',
    },
  },
});
