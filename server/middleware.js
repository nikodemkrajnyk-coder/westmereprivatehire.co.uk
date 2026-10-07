const jwt = require('jsonwebtoken');

/**
 * IS THIS ACCOUNT STILL AN ACCOUNT?
 *
 * A signed token is proof of who you were when you signed in, not proof that
 * the account still exists. Nothing checked, so for up to thirty days after a
 * customer closed their account their old cookie still authenticated as them —
 * found by driving the real erasure route end to end and then calling
 * /customer/profile with the same jar, which answered 200. The same hole holds
 * a dismissed driver's session open.
 *
 * One primary-key lookup per request, which better-sqlite3 does synchronously
 * in microseconds. A row that is missing or switched off is refused; a THROWN
 * error is not, because a broken database must not silently log out every user
 * in a way that looks like an expired session.
 * GUARDRAIL: server/tests/erasure.test.js
 */
function accountStillLive(payload) {
  if (!payload || !payload.id) return false;
  try {
    const db = require('./db').getDb();
    const table = payload.type === 'customer' ? 'customers' : 'users';
    const row = db.prepare('SELECT active FROM ' + table + ' WHERE id = ?').get(payload.id);
    if (!row) return false;
    return row.active !== 0;
  } catch (e) {
    console.error('[AUTH] could not check the account is still live:', e.message);
    return true;
  }
}

// Create auth middleware factory
function createAuthMiddleware(jwtSecret) {
  // Verify JWT token from cookie
  function requireAuth(req, res, next) {
    const token = req.cookies.wph_token;
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch (e) {
      res.clearCookie('wph_token');
      return res.status(401).json({ error: 'Session expired' });
    }
    if (!accountStillLive(payload)) {
      res.clearCookie('wph_token');
      return res.status(401).json({ error: 'Session expired' });
    }
    req.auth = payload;
    next();
  }

  // Require specific role(s)
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
      if (!roles.includes(req.auth.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    };
  }

  // Protect HTML pages — redirect to login or block access
  function protectPage(allowedRoles) {
    return (req, res, next) => {
      const token = req.cookies.wph_token;
      if (!token) {
        // Let the page load — frontend will show login form
        return next();
      }
      try {
        const payload = jwt.verify(token, jwtSecret);
        /* Same check as requireAuth: a closed account must not keep a page
           open either, or the app renders signed-in and then 401s on every
           call it makes. */
        if (!accountStillLive(payload)) {
          res.clearCookie('wph_token');
          return next();
        }
        if (allowedRoles && !allowedRoles.includes(payload.role)) {
          return res.status(403).send('Access denied');
        }
        req.auth = payload;
        next();
      } catch (e) {
        res.clearCookie('wph_token');
        next();
      }
    };
  }

  return { requireAuth, requireRole, protectPage };
}

module.exports = { createAuthMiddleware, accountStillLive };
