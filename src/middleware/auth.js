const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

function verify(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = verify(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

authenticate.optional = function (req, res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try { req.user = verify(auth.slice(7)); } catch {}
  }
  next();
};

module.exports = authenticate;
