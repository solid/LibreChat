const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * Switches between JWT and OpenID authentication based on cookies and environment settings
 */
const requireJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  // Use OpenID/Solid JWT authentication when OPENID_REUSE_TOKENS is enabled
  if (
    (tokenProvider === 'openid' || tokenProvider === 'solid') &&
    isEnabled(process.env.OPENID_REUSE_TOKENS)
  ) {
    const strategy = tokenProvider === 'solid' ? 'solidJwt' : 'openidJwt';
    return passport.authenticate(strategy, { session: false })(req, res, next);
  }

  // Default to standard JWT authentication
  return passport.authenticate('jwt', { session: false }, (err, user, _info) => {
    if (err) {
      return res.status(401).json({ error: 'Authentication failed', message: err.message });
    }
    if (!user) {
      return res.status(401).json({
        error: 'Authentication required',
        message:
          'No valid JWT token found. Make sure you are logged in and the Authorization header is sent.',
        hint: 'Access this endpoint via the frontend app, or include Authorization: Bearer <token> header',
      });
    }
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireJwtAuth;
