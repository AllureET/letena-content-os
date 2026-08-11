import pg from 'pg';

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
