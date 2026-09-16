const crypto = require('crypto');
const { pool } = require('./db');
const { sendInviteEmail, mailerStatus } = require('./mailer');

// The first administrator. Seeded with no password — the account is claimed
// by whoever follows the invite link and sets one, so no password ever passes
// through this code or through anyone else's hands.
const FOUNDER_EMAIL = 'andrew@carter-carter.net';

// Logins only bite once this is on. Until then the site behaves exactly as it
// did before, so a crew mid-turnover isn't locked out by a deploy.
const ENFORCED = () => String(process.env.AUTH_ENFORCED || '').toLowerCase() === 'true';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'field',
  password_hash TEXT,
  invite_token TEXT,
  invite_code TEXT,
  invite_expires TIMESTAMPTZ,
  invited_by INTEGER,
  disabled_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`;

const normalise = (email) => String(email || '').trim().toLowerCase();

// A code someone can read down the phone or write on a scrap of paper.
// No I, O, 0 or 1 — on site, those get misheard and mistyped every time.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeInviteCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) code += '-';
  }
  return code; // e.g. K7F2-9PQD
}

// Typed codes arrive with stray spaces, lower case and missing dashes.
const tidyCode = (value) =>
  String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Two kinds of account, and only two. Anything that isn't an administrator is
// field team: they scan, and that's the whole of it.
const asRole = (value) => (String(value || '').toLowerCase() === 'admin' ? 'admin' : 'field');

async function initAuth() {
  await pool.query(SCHEMA);
  // Existing installs predate the typed code.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT');
  // 'member' was the old name for the same thing. One name from here on.
  await pool.query("UPDATE users SET role = 'field' WHERE role <> 'admin'");
  await pool.query("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'field'");

  // Seed the founding administrator exactly once.
  const existing = await pool.query('SELECT id, invite_token, password_hash FROM users WHERE email = $1', [FOUNDER_EMAIL]);
  if (!existing.rows.length) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO users (email, name, role, invite_token, invite_code, invite_expires)
       VALUES ($1, $2, 'admin', $3, $4, now() + interval '30 days')`,
      [FOUNDER_EMAIL, 'Andrew Lyle', token, makeInviteCode()]
    );
    console.log('[auth] Founding admin seeded. Claim the account at: /login.html?invite=' + token);
  } else if (!existing.rows[0].password_hash && !existing.rows[0].invite_token) {
    // Account exists but has no way in — reissue so it can never be stranded.
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE users SET invite_token = $1, invite_expires = now() + interval '30 days' WHERE email = $2`,
      [token, FOUNDER_EMAIL]
    );
    console.log('[auth] Founding admin invite reissued: /login.html?invite=' + token);
  }
}

// ---------- Passwords ----------
// scrypt, from Node's own crypto. No native module to fail a build, and the
// plain password is never stored, logged, or sent anywhere.

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  // Constant-time compare so a wrong password can't be narrowed down by timing.
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return 'Password needs at least one letter and one number.';
  return null;
}

// ---------- Sessions ----------

const SESSION_DAYS = 120; // long, because the crew shouldn't be re-typing this on a roof

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [token, userId]
  );
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function tokenFrom(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return readCookie(req, 'session');
}

async function userFor(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.disabled_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  const user = result.rows[0];
  if (!user || user.disabled_at) return null;
  return user;
}

// Attaches req.user when signed in. Never rejects — that's requireAuth's job.
async function attachUser(req, res, next) {
  try {
    req.user = await userFor(req);
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!ENFORCED()) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}

// For the things only an administrator should be able to do to a job itself:
// create it, rename it, re-import its unit list, bin it, restore it.
//
// Signed in as field team, the answer is always no — even before sign-in is
// switched on, because by then they've told us who they are. Nobody signed in
// and sign-in not yet enforced is the old world, which still works as it did.
function adminOnly(req, res, next) {
  if (req.user) {
    if (req.user.role === 'admin') return next();
    return res.status(403).json({
      error: 'Only an administrator can change projects. You can scan any unit in them.',
    });
  }
  if (!ENFORCED()) return next();
  return res.status(401).json({ error: 'Sign in required' });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrators only' });
  }
  next();
}

// ---------- Routes ----------

function mountAuthRoutes(app) {
  app.get('/api/auth/status', async (req, res) => {
    res.json({
      enforced: ENFORCED(),
      user: req.user || null,
      mailer: mailerStatus(),
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = normalise(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // One message for every failure: never reveal which accounts exist.
    if (!user || user.disabled_at || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }

    const token = await createSession(user.id);
    await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
    // HttpOnly so no script can read it, Lax so it survives normal navigation.
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  // Claiming an invite: the invited person chooses their own password here.
  app.post('/api/auth/accept', async (req, res) => {
    const token = String((req.body && req.body.invite) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const name = String((req.body && req.body.name) || '').trim();

    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    // Two ways in: the long token from a link, or an email plus the short
    // code an administrator read out. The code is deliberately short enough
    // to dictate, so it only works alongside the matching email address.
    const email = normalise(req.body && req.body.email);
    const code = tidyCode(req.body && req.body.code);

    let result;
    if (token) {
      result = await pool.query(
        'SELECT * FROM users WHERE invite_token = $1 AND invite_expires > now()',
        [token]
      );
    } else if (email && code) {
      result = await pool.query(
        `SELECT * FROM users
         WHERE email = $1 AND invite_code IS NOT NULL
           AND replace(upper(invite_code), '-', '') = $2
           AND invite_expires > now()`,
        [email, code]
      );
    } else {
      return res.status(400).json({ error: 'Enter your email address and the invite code you were given.' });
    }

    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'That email and code don\u2019t match an open invite. Check with whoever invited you — codes expire after 14 days.' });

    await pool.query(
      `UPDATE users SET password_hash = $1, invite_token = NULL, invite_code = NULL, invite_expires = NULL,
                        name = COALESCE(NULLIF($2, ''), name), last_login = now()
       WHERE id = $3`,
      [hashPassword(password), name, user.id]
    );

    const session = await createSession(user.id);
    res.setHeader('Set-Cookie', `session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
    res.json({ token: session, user: { id: user.id, email: user.email, name: name || user.name, role: user.role } });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = tokenFrom(req);
    if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  app.post('/api/auth/password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.next) || '');
    const problem = passwordProblem(next);
    if (problem) return res.status(400).json({ error: problem });

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!verifyPassword(current, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(next), req.user.id]);
    // Every other session for this person is dropped.
    const keep = tokenFrom(req);
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user.id, keep]);
    res.json({ ok: true });
  });

  // ---------- Administration ----------

  app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query(
      `SELECT id, email, name, role, last_login, created_at, disabled_at,
              invite_code, invite_expires,
              (invite_token IS NOT NULL) AS pending
       FROM users ORDER BY role DESC, email`
    );
    res.json({ users: result.rows });
  });

  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const email = normalise(req.body && req.body.email);
    const role = asRole(req.body && req.body.role);
    const name = String((req.body && req.body.name) || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email address is required' });

    const token = crypto.randomBytes(24).toString('hex');
    const code = makeInviteCode();
    await pool.query(
      `INSERT INTO users (email, name, role, invite_token, invite_code, invite_expires, invited_by)
       VALUES ($1, $2, $3, $4, $5, now() + interval '14 days', $6)
       ON CONFLICT (email) DO UPDATE
         SET invite_token = EXCLUDED.invite_token,
             invite_code = EXCLUDED.invite_code,
             invite_expires = EXCLUDED.invite_expires,
             role = EXCLUDED.role,
             disabled_at = NULL`,
      [email, name, role, token, code, req.user ? req.user.id : null]
    );

    const base = `${req.protocol}://${req.get('host')}`;
    const link = `${base}/login.html?invite=${token}`;
    const sent = await sendInviteEmail({
      to: email,
      link,
      invitedBy: req.user ? (req.user.name || req.user.email) : 'an administrator',
    });

    // If email isn't configured (or bounced), hand the link back so the admin
    // can pass it on themselves rather than the invite silently going nowhere.
    // The code is the point now: an administrator reads it out, the person
    // types it with their email. The link is still there for anyone who'd
    // rather paste one.
    res.json({ ok: true, code, link, emailed: sent.ok, emailError: sent.error || null });
  });

  app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};

    if (body.role && asRole(body.role) === 'field' && id === req.user.id) {
      return res.status(400).json({ error: "You can't remove your own administrator access." });
    }
    if (body.role) {
      const role = asRole(body.role);
      // Never leave the job without an administrator.
      if (role === 'field') {
        const admins = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
        if (admins.rows[0].n <= 1) return res.status(400).json({ error: 'There must be at least one administrator.' });
      }
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    }
    if (body.disabled === true) {
      if (id === req.user.id) return res.status(400).json({ error: "You can't remove your own access." });
      await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [id]);
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    if (body.disabled === false) {
      await pool.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [id]);
    }
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ error: "You can't remove your own account." });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  });
}

module.exports = {
  initAuth,
  attachUser,
  requireAuth,
  requireAdmin,
  adminOnly,
  mountAuthRoutes,
  ENFORCED,
};
