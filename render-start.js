// Render launcher. Your index.js already has the web server and the self-ping, so this file
// only adds the missing piece: keeping your Microsoft login alive across Render restarts.
//   1) restore the saved login from Upstash  2) start index.js  3) keep backing the login up
// Render start command:  node render-start.js
try { require('dotenv').config(); } catch (e) { /* dotenv is optional here */ }

const { enabled, restoreAuth, startAuthBackup } = require('./authsync.js');

// One backup holds the whole login cache folder. Keep the default to reuse the login you already saved.
const AUTH_KEY = (process.env.AUTH_BACKUP_KEY || 'mcauth:woonderhoy').trim();

async function main() {
  let backup = { flush: async () => {} };

  if (enabled()) {
    await restoreAuth(AUTH_KEY);          // BEFORE any bot tries to log in
    backup = startAuthBackup(AUTH_KEY);   // saves again whenever the login changes
  } else {
    console.log('[RENDER] Upstash not configured (UPSTASH_REDIS_REST_URL / _TOKEN): login will NOT survive restarts.');
  }

  // Save the login once more when Render stops the service
  process.on('SIGTERM', async () => {
    console.log('[RENDER] SIGTERM: saving login...');
    try { await Promise.race([backup.flush(), new Promise(r => setTimeout(r, 5000))]); } catch (e) {}
    // index.js has no SIGTERM handler of its own, and a listener stops Node's default exit, so exit here
    setTimeout(() => { if (process.listenerCount('SIGTERM') <= 1) process.exit(0); }, 1500);
  });

  require('./index.js');
}

main();
