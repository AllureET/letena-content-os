// One-time recovery tool, run as root on the server:
//   cd /opt/lcos && node scripts/reset-admin.mjs
// Interactively prompts for a NEW admin password (typed by the operator,
// never passed as an argument, never logged), resets admin@letena.local,
// rotates LETENA_INGEST_SHARED_SECRET in .env (the old one was exposed),
// and rewrites /root/lcos-handoff.txt without any UI password in it.
// Restart afterwards: systemctl restart lcos-api
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const ENV_PATH = '/opt/lcos/.env';
const envText = fs.readFileSync(ENV_PATH, 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2];
}
if (!env.DATABASE_URL) { console.error('no DATABASE_URL in .env'); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const pw = (await ask('New password for admin@letena.local (min 12 chars): ')).trim();
if (pw.length < 12) { console.error('too short, needs 12 or more characters; nothing changed'); process.exit(1); }
const pw2 = (await ask('Type it again: ')).trim();
rl.close();
if (pw !== pw2) { console.error('the two entries did not match; nothing changed'); process.exit(1); }

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const hash = bcrypt.hashSync(pw, 10);
const r = await pool.query(
  "UPDATE lcos.users SET password_hash=$1 WHERE lower(email)=lower($2)",
  [hash, 'admin@letena.local']);
console.log('admin password updated, rows: ' + r.rowCount);

// Rotate the ingest secret (the previous one is treated as exposed).
const newSecret = crypto.randomBytes(24).toString('hex');
const newEnv = envText.replace(/^LETENA_INGEST_SHARED_SECRET=.*$/m,
  'LETENA_INGEST_SHARED_SECRET=' + newSecret);
fs.writeFileSync(ENV_PATH, newEnv, { mode: 0o600 });
console.log('ingest secret rotated in .env');

const ip = (env.PUBLIC_IP || '204.168.161.47');
const salt = crypto.randomBytes(24).toString('hex');
fs.writeFileSync('/root/lcos-handoff.txt',
  'LCOS handoff, regenerated ' + new Date().toISOString() + '\n\n' +
  'EMR Integration credentials page, LCOS card:\n' +
  '  LCOS base URL:      http://' + ip + ':8080\n' +
  '  LCOS ingest secret: ' + newSecret + '\n' +
  '  LCOS hash salt:     set once, never change. Suggestion: ' + salt + '\n' +
  '  Backfill window:    leave blank for 18 months.\n\n' +
  'LCOS admin UI: http://' + ip + ':8080  (admin@letena.local, the password you just set)\n',
  { mode: 0o600 });
console.log('handoff rewritten. Now run: systemctl restart lcos-api');
await pool.end();
