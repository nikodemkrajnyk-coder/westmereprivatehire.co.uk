const jwt = require('jsonwebtoken');

// Create auth middleware factory
function createAuthMiddleware(jwtSecret) {
  // Verify JWT token from cookie
  function requireAuth(req, res, next) {
    const token = req.cookies.wph_token;
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
      req.auth = jwt.verify(token, jwtSecret);
      next();
    } catch (e) {
      res.clearCookie('wph_token');
      return res.status(401).json({ error: 'Session expired' });
    }
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

module.exports = { createAuthMiddleware };
