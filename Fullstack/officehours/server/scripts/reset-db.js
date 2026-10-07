'use strict';

// Rebuild the database from sql/init.sql: drop every table, then run the same
// script docker compose runs on first start. The tests call resetDatabase()
// before each case so no test can depend on another's leftovers; you can run
// it by hand (`npm run db:reset`) to get the demo data back.

const fs = require('node:fs');
const path = require('node:path');

const INIT_SQL = fs.readFileSync(path.join(__dirname, '..', 'sql', 'init.sql'), 'utf8');

const DEFAULT_DATABASE_URL =
  'postgres://officehours_user:officehours_pass@localhost:5432/officehours';

const resetDatabase = async (pool) => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(INIT_SQL);
};

if (require.main === module) {
  const { createPool } = require('../db');
  const pool = createPool(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
  resetDatabase(pool)
    .then(() => console.log('Database reset to the demo data in sql/init.sql'))
    .catch((err) => {
      console.error('Reset failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { resetDatabase, DEFAULT_DATABASE_URL };
