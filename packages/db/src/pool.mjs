import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Why this exists (root-caused 13 Aug 2026): the live lcos-api systemd
// service works because its unit file has EnvironmentFile=/opt/lcos/.env,
// which sources .env into process.env before node ever starts. But
// `npm run migrate` / `npm run seed`, run by hand over SSH or from
// deploy.sh's SSH one-liner, get no such sourcing — process.env.DATABASE_URL
// is unset in that shell, so this file silently fell back to the hardcoded
// lcos_dev dev password and every run failed with "password authentication
// failed for user lcos". Do NOT remove this loader or assume DATABASE_URL is
// always present in the environment: migrate/seed need their own fallback.
// This only ever fills in vars that are NOT already set, so it never
// overrides systemd's (or any other) correctly-set environment.
export function loadEnvFallback(envPath) {
  const values = {};
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    // Missing .env is expected on fresh installs, CI, local dev, etc.
    // Silent no-op, matching the existing hardcoded-default behavior.
    return values;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2
      && ((value[0] === '"' && value[value.length - 1] === '"')
        || (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFallback = loadEnvFallback(join(projectRoot, '.env'));
for (const [key, value] of Object.entries(envFallback)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://lcos:lcos_dev@localhost:5432/lcos';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export async function q(text, params = []) {
  return pool.query(text, params);
}

export async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] ?? null;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
