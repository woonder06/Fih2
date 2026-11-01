// Saves/restores the Microsoft login cache (nmp-cache) in a free Upstash Redis
// database, so it survives Render's wiped filesystem.
// Needs env: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

function enabled() {
  return Boolean(URL_ && TOKEN);
}

// Same folder minecraft-protocol uses by default for the Microsoft login cache
function resolveAuthDir() {
  for (const pkg of ['minecraft-protocol', 'mineflayer']) {
    try {
      let req = createRequire(require.resolve(pkg));
      if (pkg === 'mineflayer') req = createRequire(req.resolve('minecraft-protocol'));
      return path.join(req('minecraft-folder-path'), 'nmp-cache');
    } catch (e) { /* try next */ }
  }
  return path.join(os.homedir(), '.minecraft', 'nmp-cache');
}

async function redis(command) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000) // never hang forever if Upstash is unreachable
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}

let lastKnown = '';

function snapshot(dir) {
  const files = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return '{}'; }
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) files[name] = fs.readFileSync(full, 'utf8');
    } catch (e) { /* skip unreadable */ }
  }
  return JSON.stringify(files);
}

async function restoreAuth(key, dir = resolveAuthDir()) {
  if (!enabled()) return false;
  try {
    const stored = await redis(['GET', key]);
    if (!stored) { console.log('[AUTH] No saved login in Upstash yet (first run).'); return false; }
    const files = JSON.parse(stored);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const [name, content] of Object.entries(files)) {
      if (name.includes('/') || name.includes('\\') || name.includes('..')) continue;
      fs.writeFileSync(path.join(dir, name), content);
      n++;
    }
    lastKnown = snapshot(dir);
    console.log(`[AUTH] Restored ${n} login file(s) from Upstash.`);
    return n > 0;
  } catch (e) {
    console.log(`[AUTH] Restore failed: ${e.message}`);
    return false;
  }
}

function startAuthBackup(key, { dir = resolveAuthDir(), intervalMs = 60000 } = {}) {
  if (!enabled()) return { flush: async () => {} };
  let last = lastKnown; // '' if nothing was restored, so an existing good local login gets uploaded once

  async function flush() {
    const snap = snapshot(dir);
    if (snap === '{}' || snap === last) return;
    try {
      await redis(['SET', key, snap]);
      last = snap;
      console.log('[AUTH] Login cache saved to Upstash.');
    } catch (e) {
      console.log(`[AUTH] Backup failed: ${e.message}`);
    }
  }

  setInterval(flush, intervalMs);
  return { flush };
}

module.exports = { enabled, resolveAuthDir, restoreAuth, startAuthBackup };
