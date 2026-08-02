// One-off operator utility: rotates the Postgres role's password. Deliberately
// takes both the connection string and the target password from environment
// variables rather than arguments/hardcoding — this file is safe to commit (no
// secrets in the code itself), meant to be run via a throwaway Railway service
// whose env vars supply the real values, then removed from the repo once used.
import { Client } from 'pg';

const connectionString = process.env.ROTATE_DATABASE_URL;
const newPassword = process.env.ROTATE_NEW_PASSWORD;

if (!connectionString || !newPassword) {
  console.error('ROTATE_DATABASE_URL and ROTATE_NEW_PASSWORD must both be set.');
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  // newPassword is always our own openssl-generated alphanumeric string (see
  // the operator flow that sets ROTATE_NEW_PASSWORD) — no quotes or special SQL
  // characters possible, so plain interpolation here doesn't need escaping.
  await client.query(`ALTER ROLE postgres WITH PASSWORD '${newPassword}'`);
  console.log('ROTATION_SUCCESS');
} catch (err) {
  console.error('ROTATION_FAILED', err);
  process.exitCode = 1;
} finally {
  await client.end();
}
