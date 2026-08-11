// One-time recovery tool, run as root: cd /opt/lcos && node scripts/set-ingest-secret.mjs
// Interactively prompts for the ingest secret (typed by the operator, who
// enters the SAME value in the EMR credentials page), writes it to .env,
// and restarts the lcos-api service. Minimum 16 characters.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import readline from 'node:readline';

const ENV_PATH = '/opt/lcos/.env';
const envText = fs.readFileSync(ENV_PATH, 'utf8');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const s1 = (await ask('Ingest secret to use (min 16 chars, same value goes in the EMR page): ')).trim();
if (s1.length < 16) { console.error('too short, needs 16 or more characters; nothing changed'); process.exit(1); }
const s2 = (await ask('Type it again: ')).trim();
rl.close();
if (s1 !== s2) { console.error('the two entries did not match; nothing changed'); process.exit(1); }

const newEnv = envText.replace(/^LETENA_INGEST_SHARED_SECRET=.*$/m,
  'LETENA_INGEST_SHARED_SECRET=' + s1);
fs.writeFileSync(ENV_PATH, newEnv, { mode: 0o600 });
console.log('ingest secret updated in .env, restarting the service...');
execSync('systemctl restart lcos-api', { stdio: 'inherit' });
console.log('done. Enter the same value as LCOS ingest secret in the EMR page and save.');
