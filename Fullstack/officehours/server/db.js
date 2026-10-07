'use strict';

const { Pool } = require('pg');

const createPool = (connectionString) => {
  const pool = new Pool({ connectionString });

  // An idle pooled connection can drop (say, the database restarts). Without a
  // listener, that 'error' event would crash the whole server; with one, the
  // next query just opens a fresh connection.
  pool.on('error', (err) => {
    console.error('Idle database connection lost:', err.message);
  });

  return pool;
};

// Run `work(client)` inside BEGIN/COMMIT on a single connection, rolling back
// if it throws. Several statements that must succeed or fail together go here.
const withTransaction = async (pool, work) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { createPool, withTransaction };
