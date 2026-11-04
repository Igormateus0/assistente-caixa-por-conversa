import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is empty. Fill it in the local .env file.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  await pool.query('SELECT 1');
  console.log('Database connection successful.');
} catch (error) {
  // Do not print the connection string or driver details that may reveal private host data.
  console.error(`Database connection failed (${error.code ?? 'unknown error'}). Check the local .env connection string.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
