const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * Switches between JWT and OpenID authentication based on cookies and environment settings
 */
const { logger } = require('@librechat/data-schemas');

const requireJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;
  const hasAuthHeader = !!req.headers.authorization;

  logger.info('[requireJwtAuth] Authentication check', {
    path: req.path,
    method: req.method,
    hasCookie: !!cookieHeader,
    tokenProvider,
    hasAuthHeader,
    authHeaderPrefix: req.headers.authorization?.substring(0, 30),
    openidReuseTokens: isEnabled(process.env.OPENID_REUSE_TOKENS),
  });

  // Use OpenID authentication if token provider is OpenID and OPENID_REUSE_TOKENS is enabled
  if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.debug('[requireJwtAuth] Using OpenID JWT authentication');
    return passport.authenticate('openidJwt', { session: false })(req, res, next);
  }

  // Default to standard JWT authentication
  logger.debug('[requireJwtAuth] Using standard JWT authentication');
  
  // Add error handler to log authentication failures
  return passport.authenticate('jwt', { session: false }, (err, user, info) => {
    if (err) {
      logger.error('[requireJwtAuth] Authentication error', {
        error: err.message,
        stack: err.stack,
      });
      return res.status(401).json({ error: 'Authentication failed', message: err.message });
    }
    if (!user) {
      logger.warn('[requireJwtAuth] Authentication failed - no user', {
        info: info?.message || 'No user returned from JWT strategy',
        hasAuthHeader,
        tokenProvider,
      });
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'No valid JWT token found. Make sure you are logged in and the Authorization header is sent.',
        hint: 'Access this endpoint via the frontend app, or include Authorization: Bearer <token> header',
      });
    }
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireJwtAuth;
