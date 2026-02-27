const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');
const { ensureSolidJwtRegisteredLazy } = require('../services/ensureSolidJwt');
const { sendStrategyNotRegistered503 } = require('./openIdAuthHelpers');

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * When token_provider is solid/openid we always use the corresponding strategy (no fallback).
 * For Solid, we try lazy registration once if the strategy wasn't registered at startup (e.g. IdP was down).
 */
const requireJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  if (tokenProvider === 'solid' || tokenProvider === 'openid') {
    const useOpenIdStrategy = isEnabled(process.env.OPENID_REUSE_TOKENS);
    const strategy = tokenProvider === 'solid' ? 'solidJwt' : 'openidJwt';
    const strategyRegistered =
      typeof passport._strategies === 'object' && passport._strategies[strategy];

    if (useOpenIdStrategy && strategyRegistered) {
      return passport.authenticate(strategy, { session: false })(req, res, next);
    }
    if (useOpenIdStrategy && !strategyRegistered && tokenProvider === 'solid') {
      return ensureSolidJwtRegisteredLazy()
        .then((registered) => {
          if (registered && passport._strategies && passport._strategies.solidJwt) {
            return passport.authenticate('solidJwt', { session: false })(req, res, next);
          }
          return sendStrategyNotRegistered503(res, tokenProvider, true);
        })
        .catch(next);
    }
    if (useOpenIdStrategy && !strategyRegistered) {
      return sendStrategyNotRegistered503(res, tokenProvider);
    }
  }

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
