require('dotenv').config();
const http = require('http');
const url = require('url');
const crypto = require('crypto');

console.log('====================================================');
console.log('   UltraNetwork Bot Control Center & Web Suite     ');
console.log('====================================================');

// Guard against unhandled rejections or socket drops crashing the container
process.on('unhandledRejection', err => console.error('[UNHANDLED REJECTION]', err?.message || err));
process.on('uncaughtException', err => console.error('[UNCAUGHT EXCEPTION]', err?.message || err));

// Bot registry
const bots = {
  b1: null,
  b2: null
};

// Start Bot 1 immediately
try {
  console.log('[RUNNER] Initializing Bot 1 (bot.js)...');
  bots.b1 = require('./bot.js');
} catch (err) {
  console.error('[RUNNER] Failed to load Bot 1:', err);
}

// Stagger Bot 2 by 4 seconds to avoid CPU/auth spikes
setTimeout(() => {
  try {
    console.log('[RUNNER] Initializing Bot 2 (alt.js)...');
    bots.b2 = require('./alt.js');
    console.log('[RUNNER] Bot 2 loaded successfully.');
  } catch (err) {
    console.error('[RUNNER] Failed to load Bot 2:', err);
  }
}, 4000);

// In-Memory Authentication Sessions & Brute Force Protection
const activeSessions = new Set();
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
      }
    });
  }
  return list;
}

function isAuthenticated(req, parsedUrl) {
  const expectedPassword = (process.env.DASHBOARD_PASSWORD || 'admin123').trim();

  // 1. Support Authorization Bearer header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (authHeader.slice(7).trim() === expectedPassword) return true;
  }

  // 2. Support URL query key ?key=... for direct links/scripts
  if (parsedUrl.query && parsedUrl.query.key && parsedUrl.query.key === expectedPassword) {
    return true;
  }

  // 3. Support Session Cookie
  const cookies = parseCookies(req);
  if (cookies.auth_token && activeSessions.has(cookies.auth_token)) {
    return true;
  }

  return false;
}

// Helper to parse POST request body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();
  const clientIp = getClientIp(req);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // LOGIN ENDPOINT (Public)
  if (pathname === '/api/login' && method === 'POST') {
    const attempt = loginAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
    if (Date.now() < attempt.lockedUntil) {
      const waitSeconds = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        success: false, 
        error: `Too many failed attempts. Locked out for ${waitSeconds}s.` 
      }));
    }

    try {
      const data = await parseJsonBody(req);
      const inputPass = String(data.password || '').trim();
      const expectedPass = (process.env.DASHBOARD_PASSWORD || 'admin123').trim();

      if (inputPass && inputPass === expectedPass) {
        loginAttempts.delete(clientIp);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeSessions.add(sessionToken);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `auth_token=${sessionToken}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`
        });
        return res.end(JSON.stringify({ success: true, message: 'Authentication successful' }));
      } else {
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockedUntil = Date.now() + 5 * 60 * 1000; // 5 min lockout
        }
        loginAttempts.set(clientIp, attempt);

        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
          success: false, 
          error: attempt.count >= 5 
            ? 'Too many failed attempts. Locked out for 5 minutes.' 
            : `Incorrect password. (${5 - attempt.count} attempts left)`
        }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Bad request format' }));
    }
  }

  // LOGOUT ENDPOINT (Public)
  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies.auth_token) {
      activeSessions.delete(cookies.auth_token);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax'
    });
    return res.end(JSON.stringify({ success: true, message: 'Logged out' }));
  }

  // HEALTH ENDPOINT (Public) - used by the self-ping / uptime monitors
  if (pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
  }

  // CHECK AUTHENTICATION FOR ALL OTHER ROUTES
  const authed = isAuthenticated(req, parsedUrl);

  if (!authed) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: master password required' }));
    }
    // Render modern Login Screen if not authenticated
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderLoginHtml());
  }

  // --- AUTHENTICATED ROUTES ---

  // 1. API: Status
  if (pathname === '/api/status' && method === 'GET') {
    const status = {
      b1: bots.b1 && typeof bots.b1.getStatus === 'function' 
        ? bots.b1.getStatus() 
        : { prefix: 'b1', state: bots.b1 ? 'STARTING' : 'LOADING', username: 'Bot 1' },
      b2: bots.b2 && typeof bots.b2.getStatus === 'function' 
        ? bots.b2.getStatus() 
        : { prefix: 'b2', state: bots.b2 ? 'STARTING' : 'LOADING', username: 'Bot 2 (Alt)' },
      uptime: process.uptime(),
      timestamp: Date.now()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(status));
  }

  // 2. API: Chat Log
  if (pathname === '/api/chat' && method === 'GET') {
    const botKey = parsedUrl.query.bot || 'b1';
    const targetBot = bots[botKey];
    if (!targetBot || typeof targetBot.getRecentChats !== 'function') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ bot: botKey, chats: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ bot: botKey, chats: targetBot.getRecentChats() }));
  }

  // 3. API: Screen / Inventory Canvas Image
  if (pathname === '/api/screen' && method === 'GET') {
    const botKey = parsedUrl.query.bot || 'b1';
    const targetBot = bots[botKey];
    if (targetBot && typeof targetBot.getScreenImage === 'function') {
      try {
        const imgBuffer = targetBot.getScreenImage();
        if (imgBuffer) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Length': imgBuffer.length
          });
          return res.end(imgBuffer);
        }
      } catch (err) {
        console.error('[API/SCREEN] Render error:', err.message);
      }
    }
    const emptyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(emptyPng);
  }

  // 4. API: Execute Action
  if (pathname === '/api/action' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const botKey = data.bot || 'b1';
      const action = data.action;

      if (!action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Missing action parameter' }));
      }

      const executeOnBot = async (b) => {
        if (!b) throw new Error('Target bot is not initialized');
        switch (action) {
          case 'chat':
            return b.sendChat(data.message);
          case 'start':
            return b.doStart();
          case 'stop':
            return b.doStop();
          case 'restart':
            return await b.doRestart();
          case 'walk':
            return await b.doWalk(data.steps || 5);
          case 'move':
            return await b.doMove(data.direction, data.blocks || 3);
          case 'click':
            return await b.doClickSlot(data.slot, data.mode || 0);
          case 'shiftclick':
            return await b.doClickSlot(data.slot, 1);
          case 'slot':
            return await b.doSelectHotbar(data.slot);
          case 'rightclick':
            return await b.doRightClick(data.slot);
          case 'closegui':
            return b.doCloseGui();
          case 'change':
            return b.doChangeMode(data.mode);
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      };

      if (botKey === 'both') {
        const results = [];
        if (bots.b1) {
          try { results.push({ bot: 'b1', res: await executeOnBot(bots.b1) }); } catch (e) { results.push({ bot: 'b1', error: e.message }); }
        }
        if (bots.b2) {
          try { results.push({ bot: 'b2', res: await executeOnBot(bots.b2) }); } catch (e) { results.push({ bot: 'b2', error: e.message }); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, results }));
      }

      const targetBot = bots[botKey];
      if (!targetBot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `Bot "${botKey}" not found or still loading` }));
      }

      const result = await executeOnBot(targetBot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // 5. Serve Authenticated Dashboard
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderDashboardHtml());
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 16657);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Web Control Center active on port ${PORT}`);
  console.log(`[HTTP] Access via: http://78.154.103.8:${PORT} or https://wegus.wispbyte.app`);
});

// SELF-PING (keeps Render free instances from spinning down after ~15 min idle)
// Render sets RENDER_EXTERNAL_URL automatically. You can override with PING_URL.
const PING_BASE = (process.env.PING_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 10 * 60 * 1000); // 10 min

if (PING_BASE) {
  const target = PING_BASE + '/health';
  const client = target.startsWith('https') ? require('https') : http;

  const selfPing = () => {
    const req = client.get(target, { timeout: 15000 }, (r) => {
      console.log(`[PING] ${target} -> ${r.statusCode}`);
      r.resume(); // discard body
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => console.error('[PING] failed:', e.message));
  };

  setInterval(selfPing, PING_INTERVAL_MS);
  console.log(`[PING] Self-ping enabled: ${target} every ${Math.round(PING_INTERVAL_MS / 60000)} min`);
} else {
  console.log('[PING] Self-ping disabled (set RENDER_EXTERNAL_URL or PING_URL to enable)');
}

// LOGIN SCREEN (High Aesthetics, Dark Mode Glassmorphism)
function renderLoginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Access - UltraNetwork Bot Controller</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    body {
      background-color: #0b0f19;
      background-image: 
        radial-gradient(at 0% 0%, rgba(59, 130, 246, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
        radial-gradient(at 50% 50%, rgba(6, 182, 212, 0.08) 0px, transparent 70%);
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .auth-card {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 2.5rem 2.25rem;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(59, 130, 246, 0.15);
      text-align: center;
      position: relative;
      overflow: hidden;
      animation: fadeIn 0.4s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.96) translateY(10px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .lock-badge {
      width: 64px;
      height: 64px;
      border-radius: 18px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1.85rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 0 25px rgba(59, 130, 246, 0.5);
    }

    h1 {
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      font-size: 0.82rem;
      color: #94a3b8;
      margin-bottom: 1.75rem;
    }

    .input-group {
      margin-bottom: 1.25rem;
      text-align: left;
    }

    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 0.5rem;
    }

    .input-wrapper {
      position: relative;
    }

    input[type="password"], input[type="text"] {
      width: 100%;
      background: rgba(9, 13, 22, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 0.85rem 2.75rem 0.85rem 1rem;
      color: white;
      font-size: 0.95rem;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      transition: all 0.2s ease;
    }

    input:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
      background: rgba(9, 13, 22, 0.95);
    }

    .eye-btn {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: #64748b;
      cursor: pointer;
      font-size: 1.1rem;
      padding: 4px;
    }

    .eye-btn:hover {
      color: #94a3b8;
    }

    .btn-submit {
      width: 100%;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
      border: none;
      padding: 0.85rem;
      border-radius: 12px;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 15px rgba(37, 99, 235, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    .btn-submit:hover {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.45);
    }

    .btn-submit:active {
      transform: translateY(0);
    }

    .error-box {
      margin-top: 1rem;
      padding: 0.65rem 0.85rem;
      border-radius: 10px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      font-size: 0.8rem;
      display: none;
      animation: shake 0.35s ease;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }

    .footer-note {
      margin-top: 1.75rem;
      font-size: 0.72rem;
      color: #64748b;
    }
  </style>
</head>
<body>

  <div class="auth-card" id="auth-box">
    <div class="lock-badge">🔐</div>
    <h1>Security Access</h1>
    <p class="subtitle">Enter master password to access UltraNetwork bot dashboard</p>

    <div class="input-group">
      <label for="password-input">Master Password</label>
      <div class="input-wrapper">
        <input type="password" id="password-input" placeholder="Enter password..." autofocus onkeydown="if(event.key==='Enter') submitLogin()">
        <button class="eye-btn" type="button" onclick="togglePassword()">👁️</button>
      </div>
    </div>

    <button class="btn-submit" id="btn-login" onclick="submitLogin()">
      <span>Unlock Dashboard</span> ➔
    </button>

    <div class="error-box" id="error-msg"></div>

    <div class="footer-note">
      End-to-end encrypted session • Auto-lock on idle
    </div>
  </div>

  <script>
    function togglePassword() {
      const input = document.getElementById('password-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    async function submitLogin() {
      const input = document.getElementById('password-input');
      const errBox = document.getElementById('error-msg');
      const btn = document.getElementById('btn-login');
      const pass = input.value.trim();

      if (!pass) {
        showError('Please enter the dashboard password.');
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Verifying...';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();

        if (data.success) {
          btn.innerText = 'Access Granted!';
          btn.style.background = '#10b981';
          setTimeout(() => {
            window.location.reload();
          }, 300);
        } else {
          showError(data.error || 'Invalid password');
          btn.disabled = false;
          btn.innerHTML = '<span>Unlock Dashboard</span> ➔';
          input.value = '';
          input.focus();
        }
      } catch (err) {
        showError('Network error connecting to server.');
        btn.disabled = false;
        btn.innerHTML = '<span>Unlock Dashboard</span> ➔';
      }
    }

    function showError(msg) {
      const errBox = document.getElementById('error-msg');
      errBox.innerText = msg;
      errBox.style.display = 'block';
      const card = document.getElementById('auth-box');
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = 'shake 0.35s ease';
    }
  </script>
</body>
</html>`;
}

// HTML Web Dashboard
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UltraNetwork Bot Command Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(17, 24, 39, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-border-hover: rgba(59, 130, 246, 0.4);
      --accent-blue: #3b82f6;
      --accent-cyan: #06b6d4;
      --accent-green: #10b981;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --accent-purple: #8b5cf6;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --radius: 14px;
      --radius-sm: 8px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(59, 130, 246, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.1) 0px, transparent 50%),
        radial-gradient(at 50% 50%, rgba(6, 182, 212, 0.05) 0px, transparent 70%);
      background-attachment: fixed;
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Navbar */
    header {
      background: rgba(11, 15, 25, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--card-border);
      position: sticky;
      top: 0;
      z-index: 50;
      padding: 0.85rem 1.5rem;
    }

    .nav-container {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.4);
    }

    .brand-text h1 {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 0.72rem;
      color: var(--text-muted);
    }

    /* Bot Selector Tabs */
    .tab-pills {
      display: flex;
      background: rgba(255, 255, 255, 0.04);
      padding: 4px;
      border-radius: 12px;
      border: 1px solid var(--card-border);
      gap: 4px;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.45rem 0.95rem;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }

    .tab-btn.active {
      background: var(--accent-blue);
      color: #ffffff;
      box-shadow: 0 0 12px rgba(59, 130, 246, 0.4);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-red);
      display: inline-block;
      transition: background 0.3s;
    }

    .status-dot.online {
      background: var(--accent-green);
      box-shadow: 0 0 8px var(--accent-green);
    }

    .status-dot.connecting {
      background: var(--accent-amber);
      animation: pulse 1s infinite alternate;
    }

    @keyframes pulse {
      from { opacity: 0.4; }
      to { opacity: 1; }
    }

    /* Global Nav Actions */
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .btn {
      padding: 0.45rem 0.85rem;
      border-radius: var(--radius-sm);
      font-size: 0.8rem;
      font-weight: 600;
      border: 1px solid var(--card-border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    .btn:active {
      transform: translateY(0);
    }

    .btn-primary {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
      color: white;
    }

    .btn-primary:hover {
      background: #2563eb;
      box-shadow: 0 0 12px rgba(37, 99, 235, 0.5);
    }

    .btn-success {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.3);
      color: #34d399;
    }

    .btn-success:hover {
      background: var(--accent-green);
      color: white;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #f87171;
    }

    .btn-danger:hover {
      background: var(--accent-red);
      color: white;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
    }

    .btn-amber {
      background: rgba(245, 158, 11, 0.15);
      border-color: rgba(245, 158, 11, 0.3);
      color: #fbbf24;
    }

    .btn-amber:hover {
      background: var(--accent-amber);
      color: white;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.4);
    }

    /* Container Layout */
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 1.25rem;
      flex: 1;
      width: 100%;
    }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 0.75rem 1.25rem;
      background: #1e293b;
      border: 1px solid var(--accent-blue);
      color: white;
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 100;
    }

    #toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* Status Bar Cards */
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    .status-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 1rem;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }

    .status-card:hover {
      border-color: var(--card-border-hover);
    }

    .status-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .status-card-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      font-weight: 600;
    }

    .status-card-value {
      font-size: 1.25rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-badge {
      font-size: 0.72rem;
      padding: 0.2rem 0.55rem;
      border-radius: 20px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-online { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-offline { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-connecting { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }

    /* Meter Bars (Health & Food) */
    .meter-container {
      margin-top: 0.5rem;
    }

    .meter-bar {
      height: 7px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      overflow: hidden;
    }

    .meter-fill {
      height: 100%;
      transition: width 0.4s ease;
      border-radius: 4px;
    }

    .meter-fill.health { background: linear-gradient(90deg, #f43f5e, #ef4444); }
    .meter-fill.food { background: linear-gradient(90deg, #f59e0b, #d97706); }

    /* Quick Action Ribbon */
    .action-ribbon {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 0.85rem 1.25rem;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .ribbon-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .ribbon-label {
      font-size: 0.78rem;
      color: var(--text-dim);
      font-weight: 600;
      margin-right: 0.25rem;
    }

    /* Workspace 2-Column Grid */
    .workspace-grid {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 1.25rem;
    }

    @media (max-width: 1024px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Terminal Window */
    .terminal-card {
      background: #090d16;
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      display: flex;
      flex-direction: column;
      height: 620px;
      overflow: hidden;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
    }

    .terminal-header {
      background: #0f172a;
      padding: 0.65rem 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .terminal-dots {
      display: flex;
      gap: 6px;
    }

    .t-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .t-red { background: #ef4444; }
    .t-yellow { background: #f59e0b; }
    .t-green { background: #10b981; }

    .terminal-title {
      font-size: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
    }

    .terminal-body {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .chat-line {
      word-break: break-word;
      display: flex;
      gap: 0.5rem;
    }

    .chat-time {
      color: var(--text-dim);
      font-size: 0.72rem;
      flex-shrink: 0;
      user-select: none;
    }

    .chat-text {
      color: #e2e8f0;
    }

    .chat-self {
      color: #38bdf8;
      font-weight: 600;
    }

    .terminal-chips {
      padding: 0.5rem 0.85rem;
      background: #0d1322;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      gap: 0.4rem;
      overflow-x: auto;
    }

    .chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      border-radius: 6px;
      font-size: 0.72rem;
      padding: 0.2rem 0.5rem;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }

    .chip:hover {
      background: var(--accent-blue);
      color: white;
      border-color: var(--accent-blue);
    }

    .terminal-input-bar {
      padding: 0.75rem 1rem;
      background: #0f172a;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      gap: 0.5rem;
    }

    .terminal-input {
      flex: 1;
      background: #090d16;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-sm);
      color: white;
      padding: 0.55rem 0.85rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      outline: none;
      transition: border-color 0.2s;
    }

    .terminal-input:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }

    /* Right Column: GUI & Controls */
    .controls-stack {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .panel-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 1.15rem;
      backdrop-filter: blur(12px);
    }

    .panel-title {
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 0.85rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Screen Canvas Viewer */
    .screen-container {
      background: #080c14;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      padding: 0.5rem;
      text-align: center;
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .screen-img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
      image-rendering: pixelated;
    }

    .screen-placeholder {
      color: var(--text-dim);
      font-size: 0.82rem;
    }

    .screen-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.75rem;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .input-sm {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      color: white;
      padding: 0.4rem 0.65rem;
      font-size: 0.8rem;
      outline: none;
      width: 75px;
      text-align: center;
    }

    /* Hotbar Row */
    .hotbar-grid {
      display: grid;
      grid-template-columns: repeat(9, 1fr);
      gap: 4px;
      margin-top: 0.75rem;
    }

    .hotbar-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.45rem 0;
      cursor: pointer;
      transition: all 0.15s;
    }

    .hotbar-btn:hover {
      background: var(--accent-blue);
      color: white;
      border-color: var(--accent-blue);
    }

    /* Movement D-pad */
    .movement-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      align-items: center;
    }

    @media (max-width: 600px) {
      .movement-layout {
        grid-template-columns: 1fr;
      }
    }

    .dpad-container {
      display: grid;
      grid-template-columns: repeat(3, 44px);
      grid-template-rows: repeat(3, 44px);
      gap: 6px;
      justify-content: center;
    }

    .dpad-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      color: var(--text-main);
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }

    .dpad-btn:hover {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
      color: white;
      transform: scale(1.05);
    }

    .dpad-btn.center {
      background: rgba(255, 255, 255, 0.02);
      border-color: transparent;
      cursor: default;
    }

    .walk-controls {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .compass-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }

    .compass-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.35rem 0;
      cursor: pointer;
      text-align: center;
    }

    .compass-btn:hover {
      background: var(--accent-cyan);
      color: white;
    }

    /* Dual View Layout */
    .dual-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
    }

    @media (max-width: 1100px) {
      .dual-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Footer */
    footer {
      border-top: 1px solid var(--card-border);
      padding: 1rem 1.5rem;
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-dim);
      margin-top: 2rem;
      background: rgba(11, 15, 25, 0.6);
    }
  </style>
</head>
<body>

  <!-- Toast Element -->
  <div id="toast">Action feedback</div>

  <!-- Navbar -->
  <header>
    <div class="nav-container">
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div class="brand-text">
          <h1>UltraNetwork Bot Controller</h1>
          <p>Multi-Account Low-CPU Manager</p>
        </div>
      </div>

      <!-- Account Switcher Tabs -->
      <div class="tab-pills">
        <button class="tab-btn active" id="tab-b1" onclick="switchView('b1')">
          <span class="status-dot" id="dot-b1"></span>
          <span>Bot 1 (Main)</span>
        </button>
        <button class="tab-btn" id="tab-b2" onclick="switchView('b2')">
          <span class="status-dot" id="dot-b2"></span>
          <span>Bot 2 (Alt)</span>
        </button>
        <button class="tab-btn" id="tab-dual" onclick="switchView('dual')">
          <span>👥 Dual View</span>
        </button>
      </div>

      <!-- Global Actions & Logout -->
      <div class="nav-actions">
        <button class="btn btn-amber" onclick="triggerAction('both', 'restart')">
          <span>🔄</span> Restart Both
        </button>
        <button class="btn btn-danger" onclick="triggerAction('both', 'stop')">
          <span>🛑</span> Stop Both
        </button>
        <button class="btn" style="background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.25); color: #fca5a5;" onclick="logout()">
          <span>🔒</span> Logout
        </button>
      </div>
    </div>
  </header>

  <main>
    <!-- SINGLE BOT VIEW -->
    <div id="single-view">
      
      <!-- Top Metrics Ribbon -->
      <div class="status-grid">
        <div class="status-card">
          <div class="status-card-header">
            <span class="status-card-title">Account State</span>
            <span class="status-badge badge-offline" id="badge-state">OFFLINE</span>
          </div>
          <div class="status-card-value" id="val-username">Loading...</div>
          <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;" id="val-server">mc.ultranetwork.net</p>
        </div>

        <div class="status-card">
          <div class="status-card-header">
            <span class="status-card-title">Vitals</span>
            <span style="font-size: 0.75rem; font-weight: 600; color: #f43f5e;" id="val-vitals">HP: -- | Food: --</span>
          </div>
          <div class="meter-container">
            <div class="meter-bar" style="margin-bottom: 6px;">
              <div class="meter-fill health" id="bar-health" style="width: 0%;"></div>
            </div>
            <div class="meter-bar">
              <div class="meter-fill food" id="bar-food" style="width: 0%;"></div>
            </div>
          </div>
        </div>

        <div class="status-card">
          <div class="status-card-header">
            <span class="status-card-title">Position & Rotation</span>
            <span style="font-size: 0.72rem; color: var(--accent-cyan); font-weight: 600;" id="val-ping">-- ms</span>
          </div>
          <div class="status-card-value" style="font-size: 0.95rem; font-family: 'JetBrains Mono', monospace;" id="val-coords">
            X: 0 | Y: 0 | Z: 0
          </div>
          <p style="font-size: 0.72rem; color: var(--text-dim); margin-top: 4px;" id="val-facing">Yaw: 0° | Pitch: 0°</p>
        </div>

        <div class="status-card">
          <div class="status-card-header">
            <span class="status-card-title">Gamemode & GUI</span>
            <span class="status-badge" style="background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.3);" id="val-mode">PRISON</span>
          </div>
          <div class="status-card-value" style="font-size: 0.92rem;" id="val-gui">No GUI Open</div>
          <p style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Low-CPU suppression active</p>
        </div>
      </div>

      <!-- Quick Action Bar -->
      <div class="action-ribbon">
        <div class="ribbon-group">
          <span class="ribbon-label">POWER:</span>
          <button class="btn btn-success" onclick="executeCurrentBot('start')">▶ Start</button>
          <button class="btn btn-danger" onclick="executeCurrentBot('stop')">⏹ Stop</button>
          <button class="btn btn-amber" onclick="executeCurrentBot('restart')">🔄 Restart</button>
        </div>

        <div class="ribbon-group">
          <span class="ribbon-label">SWITCH MODE:</span>
          <button class="btn" onclick="executeCurrentBot('change', { mode: 'prison' })">⛏ Prison</button>
          <button class="btn" onclick="executeCurrentBot('change', { mode: 'survival' })">🌲 Survival</button>
          <button class="btn" onclick="executeCurrentBot('closegui')">❌ Close GUI</button>
        </div>
      </div>

      <!-- Interactive 2-Column Grid -->
      <div class="workspace-grid">
        
        <!-- Left Column: Terminal & Chat -->
        <div class="terminal-card">
          <div class="terminal-header">
            <div class="terminal-dots">
              <span class="t-dot t-red"></span>
              <span class="t-dot t-yellow"></span>
              <span class="t-dot t-green"></span>
            </div>
            <span class="terminal-title" id="terminal-bot-title">b1@mc.ultranetwork.net - Live Chat</span>
            <button class="btn" style="padding: 2px 8px; font-size: 0.7rem;" onclick="clearChatLog()">Clear</button>
          </div>

          <div class="terminal-body" id="chat-stream">
            <div class="chat-line"><span class="chat-time">--:--:--</span><span class="chat-text">Connecting to server chat stream...</span></div>
          </div>

          <!-- Quick Chat Command Chips -->
          <div class="terminal-chips">
            <span class="chip" onclick="sendQuickChat('/spawn')">/spawn</span>
            <span class="chip" onclick="sendQuickChat('/sell all')">/sell all</span>
            <span class="chip" onclick="sendQuickChat('/p')">/p</span>
            <span class="chip" onclick="sendQuickChat('/s')">/s</span>
            <span class="chip" onclick="sendQuickChat('/balance')">/balance</span>
            <span class="chip" onclick="sendQuickChat('/rank')">/rank</span>
            <span class="chip" onclick="sendQuickChat('/fly')">/fly</span>
            <span class="chip" onclick="sendQuickChat('/feed')">/feed</span>
          </div>

          <!-- Chat Input -->
          <div class="terminal-input-bar">
            <input type="text" id="chat-input" class="terminal-input" placeholder="Type in-game message or command (/...) and press Enter" onkeydown="handleChatKey(event)">
            <button class="btn btn-primary" onclick="submitChat()">Send</button>
          </div>
        </div>

        <!-- Right Column: Visual GUI & Controls -->
        <div class="controls-stack">
          
          <!-- Screen / Inventory Viewer -->
          <div class="panel-card">
            <div class="panel-title">
              <span>🖼️ Container / Inventory Screen</span>
              <button class="btn" style="padding: 3px 8px; font-size: 0.72rem;" onclick="refreshScreen()">🔄 Refresh</button>
            </div>

            <div class="screen-container">
              <img id="screen-img" class="screen-img" src="/api/screen?bot=b1" alt="Bot Screen" onerror="this.style.display='none'; document.getElementById('screen-ph').style.display='block';" onload="this.style.display='block'; document.getElementById('screen-ph').style.display='none';">
              <div id="screen-ph" class="screen-placeholder" style="display: none;">GUI / Inventory Not Active</div>
            </div>

            <!-- Slot Click Toolbar -->
            <div class="screen-toolbar">
              <div style="display: flex; align-items: center; gap: 0.4rem;">
                <label style="font-size: 0.75rem; color: var(--text-muted);">Slot #:</label>
                <input type="number" id="input-slot" class="input-sm" value="0" min="0" max="64">
              </div>
              <div style="display: flex; gap: 0.4rem;">
                <button class="btn" onclick="executeCurrentBot('click', { slot: document.getElementById('input-slot').value })">Left Click</button>
                <button class="btn" onclick="executeCurrentBot('shiftclick', { slot: document.getElementById('input-slot').value })">Shift Click</button>
              </div>
            </div>

            <!-- Hotbar Quick Selector -->
            <div style="margin-top: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 0.75rem; color: var(--text-dim); font-weight: 600;">HOTBAR SLOTS (0 - 8):</span>
                <button class="btn" style="padding: 2px 7px; font-size: 0.72rem;" onclick="executeCurrentBot('rightclick')">✋ Right-Click Held</button>
              </div>
              <div class="hotbar-grid">
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 0 })">0</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 1 })">1</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 2 })">2</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 3 })">3</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 4 })">4</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 5 })">5</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 6 })">6</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 7 })">7</button>
                <button class="hotbar-btn" onclick="executeCurrentBot('slot', { slot: 8 })">8</button>
              </div>
            </div>
          </div>

          <!-- Movement & D-Pad Controller -->
          <div class="panel-card">
            <div class="panel-title">
              <span>🎮 Movement & Navigation</span>
            </div>

            <div class="movement-layout">
              <!-- D-Pad -->
              <div class="dpad-container">
                <div></div>
                <button class="dpad-btn" title="Move Forward" onclick="executeCurrentBot('move', { direction: 'forward', blocks: 3 })">▲</button>
                <div></div>
                <button class="dpad-btn" title="Move Left" onclick="executeCurrentBot('move', { direction: 'left', blocks: 3 })">◀</button>
                <div class="dpad-btn center">●</div>
                <button class="dpad-btn" title="Move Right" onclick="executeCurrentBot('move', { direction: 'right', blocks: 3 })">▶</button>
                <div></div>
                <button class="dpad-btn" title="Move Backward" onclick="executeCurrentBot('move', { direction: 'backward', blocks: 3 })">▼</button>
                <div></div>
              </div>

              <!-- Walk Steps & Cardinal -->
              <div class="walk-controls">
                <div style="display: flex; gap: 0.4rem; align-items: center;">
                  <label style="font-size: 0.75rem; color: var(--text-muted);">Steps:</label>
                  <input type="number" id="input-steps" class="input-sm" value="5" min="1" max="50">
                  <button class="btn btn-primary" style="flex: 1;" onclick="executeCurrentBot('walk', { steps: document.getElementById('input-steps').value })">
                    🚶 Walk Forward
                  </button>
                </div>

                <div style="margin-top: 0.5rem;">
                  <span style="font-size: 0.72rem; color: var(--text-dim); font-weight: 600; display: block; margin-bottom: 4px;">CARDINAL DIRECTIONS:</span>
                  <div class="compass-grid">
                    <button class="compass-btn" onclick="executeCurrentBot('move', { direction: 'north', blocks: 3 })">North</button>
                    <button class="compass-btn" onclick="executeCurrentBot('move', { direction: 'south', blocks: 3 })">South</button>
                    <button class="compass-btn" onclick="executeCurrentBot('move', { direction: 'east', blocks: 3 })">East</button>
                    <button class="compass-btn" onclick="executeCurrentBot('move', { direction: 'west', blocks: 3 })">West</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- DUAL VIEW (SIDE BY SIDE) -->
    <div id="dual-view" style="display: none;">
      <div class="dual-grid">
        <!-- Bot 1 Column -->
        <div class="panel-card">
          <div class="panel-title">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="status-dot" id="dual-dot-b1"></span>
              <span id="dual-title-b1">Bot 1 (Main)</span>
            </div>
            <div style="display: flex; gap: 0.3rem;">
              <button class="btn btn-success" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b1', 'start')">Start</button>
              <button class="btn btn-danger" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b1', 'stop')">Stop</button>
              <button class="btn btn-amber" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b1', 'restart')">Restart</button>
            </div>
          </div>
          <p style="font-size: 0.8rem; margin-bottom: 0.75rem; color: var(--text-muted);" id="dual-status-b1">State: OFFLINE</p>
          <div class="terminal-body" id="dual-chat-b1" style="height: 380px; background: #090d16; border-radius: var(--radius-sm); border: 1px solid var(--card-border);"></div>
          <div style="display: flex; gap: 0.4rem; margin-top: 0.75rem;">
            <input type="text" id="dual-input-b1" class="terminal-input" placeholder="Chat to Bot 1..." onkeydown="if(event.key==='Enter') sendDualChat('b1')">
            <button class="btn btn-primary" onclick="sendDualChat('b1')">Send</button>
          </div>
        </div>

        <!-- Bot 2 Column -->
        <div class="panel-card">
          <div class="panel-title">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="status-dot" id="dual-dot-b2"></span>
              <span id="dual-title-b2">Bot 2 (Alt)</span>
            </div>
            <div style="display: flex; gap: 0.3rem;">
              <button class="btn btn-success" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b2', 'start')">Start</button>
              <button class="btn btn-danger" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b2', 'stop')">Stop</button>
              <button class="btn btn-amber" style="padding: 2px 7px; font-size: 0.7rem;" onclick="triggerAction('b2', 'restart')">Restart</button>
            </div>
          </div>
          <p style="font-size: 0.8rem; margin-bottom: 0.75rem; color: var(--text-muted);" id="dual-status-b2">State: OFFLINE</p>
          <div class="terminal-body" id="dual-chat-b2" style="height: 380px; background: #090d16; border-radius: var(--radius-sm); border: 1px solid var(--card-border);"></div>
          <div style="display: flex; gap: 0.4rem; margin-top: 0.75rem;">
            <input type="text" id="dual-input-b2" class="terminal-input" placeholder="Chat to Bot 2..." onkeydown="if(event.key==='Enter') sendDualChat('b2')">
            <button class="btn btn-primary" onclick="sendDualChat('b2')">Send</button>
          </div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <p>UltraNetwork Bot Control Panel • Protected Session • Auto-syncing every 2s</p>
  </footer>

  <script>
    let currentBot = 'b1';
    let isDual = false;
    let latestStatus = {};

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3500);
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.reload();
      } catch (e) {
        window.location.reload();
      }
    }

    function switchView(view) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      const singleView = document.getElementById('single-view');
      const dualView = document.getElementById('dual-view');

      if (view === 'dual') {
        isDual = true;
        document.getElementById('tab-dual').classList.add('active');
        singleView.style.display = 'none';
        dualView.style.display = 'block';
        updateDualChats();
      } else {
        isDual = false;
        currentBot = view;
        document.getElementById('tab-' + view).classList.add('active');
        singleView.style.display = 'block';
        dualView.style.display = 'none';
        document.getElementById('terminal-bot-title').innerText = view + '@mc.ultranetwork.net - Live Chat';
        refreshScreen();
        updateUI();
      }
    }

    async function triggerAction(bot, action, params = {}) {
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot, action, ...params })
        });
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        const data = await res.json();
        if (data.success) {
          showToast(data.result || 'Action executed successfully');
          fetchStatus();
        } else {
          showToast('Error: ' + (data.error || 'Failed'));
        }
      } catch (err) {
        showToast('Network error: ' + err.message);
      }
    }

    function executeCurrentBot(action, params = {}) {
      triggerAction(currentBot, action, params);
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        latestStatus = await res.json();
        updateUI();
      } catch (e) {}
    }

    function updateUI() {
      if (!latestStatus || !latestStatus.b1) return;

      // Update Nav status dots
      const setDot = (id, st) => {
        const dot = document.getElementById(id);
        if (!dot) return;
        dot.className = 'status-dot';
        if (st === 'ONLINE') dot.classList.add('online');
        else if (st === 'CONNECTING' || st === 'RECONNECTING' || st === 'STARTING') dot.classList.add('connecting');
      };

      setDot('dot-b1', latestStatus.b1.state);
      setDot('dot-b2', latestStatus.b2.state);
      setDot('dual-dot-b1', latestStatus.b1.state);
      setDot('dual-dot-b2', latestStatus.b2.state);

      // Single View values
      const b = latestStatus[currentBot] || {};
      const stateBadge = document.getElementById('badge-state');
      stateBadge.innerText = b.state || 'OFFLINE';
      stateBadge.className = 'status-badge ' + (b.state === 'ONLINE' ? 'badge-online' : (b.state === 'CONNECTING' || b.state === 'STARTING' ? 'badge-connecting' : 'badge-offline'));

      document.getElementById('val-username').innerText = b.username || (currentBot === 'b1' ? 'Bot 1' : 'Bot 2');
      
      // Health & Food
      const hp = b.health != null ? b.health : 0;
      const food = b.food != null ? b.food : 0;
      document.getElementById('val-vitals').innerText = 'HP: ' + hp + '/20 | Food: ' + food + '/20';
      document.getElementById('bar-health').style.width = Math.min(100, (hp / 20) * 100) + '%';
      document.getElementById('bar-food').style.width = Math.min(100, (food / 20) * 100) + '%';

      // Coords
      if (b.pos) {
        document.getElementById('val-coords').innerText = 'X: ' + b.pos.x + ' | Y: ' + b.pos.y + ' | Z: ' + b.pos.z;
        document.getElementById('val-facing').innerText = 'Yaw: ' + b.pos.yaw + '° | Pitch: ' + b.pos.pitch + '°';
      } else {
        document.getElementById('val-coords').innerText = 'X: -- | Y: -- | Z: --';
        document.getElementById('val-facing').innerText = 'Yaw: -- | Pitch: --';
      }

      document.getElementById('val-ping').innerText = (b.ping != null ? b.ping : '--') + ' ms';
      document.getElementById('val-mode').innerText = (b.mode || 'PRISON').toUpperCase();
      document.getElementById('val-gui').innerText = b.hasWindow ? (b.windowTitle || 'Container Open') : 'No GUI Open';

      // Dual view summaries
      const b1 = latestStatus.b1 || {};
      const b2 = latestStatus.b2 || {};
      document.getElementById('dual-title-b1').innerText = (b1.username || 'Bot 1') + ' (' + (b1.state || 'OFFLINE') + ')';
      document.getElementById('dual-title-b2').innerText = (b2.username || 'Bot 2') + ' (' + (b2.state || 'OFFLINE') + ')';
      document.getElementById('dual-status-b1').innerText = 'HP: ' + (b1.health ?? '--') + ' | Mode: ' + (b1.mode || 'prison') + ' | Ping: ' + (b1.ping ?? '--') + 'ms';
      document.getElementById('dual-status-b2').innerText = 'HP: ' + (b2.health ?? '--') + ' | Mode: ' + (b2.mode || 'survival') + ' | Ping: ' + (b2.ping ?? '--') + 'ms';
    }

    async function fetchChat() {
      if (isDual) {
        updateDualChats();
        return;
      }
      try {
        const res = await fetch('/api/chat?bot=' + currentBot);
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        const data = await res.json();
        const container = document.getElementById('chat-stream');
        if (!data.chats || data.chats.length === 0) return;

        const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;
        container.innerHTML = data.chats.map(c => {
          const isSelf = c.text.startsWith('>');
          return '<div class="chat-line">' +
            '<span class="chat-time">[' + c.time + ']</span>' +
            '<span class="chat-text' + (isSelf ? ' chat-self' : '') + '">' + escapeHtml(c.text) + '</span>' +
          '</div>';
        }).join('');

        if (isAtBottom) {
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) {}
    }

    async function updateDualChats() {
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/chat?bot=b1').then(r => r.json()),
          fetch('/api/chat?bot=b2').then(r => r.json())
        ]);
        renderChatBox('dual-chat-b1', r1.chats || []);
        renderChatBox('dual-chat-b2', r2.chats || []);
      } catch (e) {}
    }

    function renderChatBox(elId, chats) {
      const container = document.getElementById(elId);
      if (!container) return;
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;
      container.innerHTML = chats.map(c => {
        const isSelf = c.text.startsWith('>');
        return '<div class="chat-line">' +
          '<span class="chat-time">[' + c.time + ']</span>' +
          '<span class="chat-text' + (isSelf ? ' chat-self' : '') + '">' + escapeHtml(c.text) + '</span>' +
        '</div>';
      }).join('');
      if (isAtBottom) container.scrollTop = container.scrollHeight;
    }

    function refreshScreen() {
      const img = document.getElementById('screen-img');
      if (img) {
        img.src = '/api/screen?bot=' + currentBot + '&t=' + Date.now();
      }
    }

    function submitChat() {
      const input = document.getElementById('chat-input');
      const msg = input.value.trim();
      if (!msg) return;
      executeCurrentBot('chat', { message: msg });
      input.value = '';
      setTimeout(fetchChat, 200);
    }

    function sendQuickChat(cmd) {
      executeCurrentBot('chat', { message: cmd });
      setTimeout(fetchChat, 200);
    }

    function sendDualChat(bot) {
      const input = document.getElementById('dual-input-' + bot);
      const msg = input.value.trim();
      if (!msg) return;
      triggerAction(bot, 'chat', { message: msg });
      input.value = '';
      setTimeout(updateDualChats, 200);
    }

    function handleChatKey(e) {
      if (e.key === 'Enter') submitChat();
    }

    function clearChatLog() {
      document.getElementById('chat-stream').innerHTML = '';
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Smart auto-polling: Poll every 2.5s only when tab is active (pauses when hidden/minimized)
    function pollLoop() {
      if (!document.hidden) {
        fetchStatus();
        fetchChat();
      }
    }
    setInterval(pollLoop, 2500);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        fetchStatus();
        fetchChat();
      }
    });

    // Initial load
    fetchStatus();
    fetchChat();
  </script>
</body>
</html>`;
}
