const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');
const { ensureSolidJwtRegisteredLazy } = require('../services/ensureSolidJwt');
const { sendStrategyNotRegistered503 } = require('./openIdAuthHelpers');

// This middleware does not require authentication,
// but if the user is authenticated, it will set the user object.
// When token_provider is solid/openid we always use the corresponding strategy (no fallback).
const optionalJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;
  const callback = (err, user) => {
    if (err) {
      return next(err);
    }
    if (user) {
      req.user = user;
    }
    next();
  };

  if (tokenProvider === 'solid' || tokenProvider === 'openid') {
    const useOpenIdStrategy = isEnabled(process.env.OPENID_REUSE_TOKENS);
    const strategy = tokenProvider === 'solid' ? 'solidJwt' : 'openidJwt';
    const strategyRegistered =
      typeof passport._strategies === 'object' && passport._strategies[strategy];

    if (useOpenIdStrategy && strategyRegistered) {
      return passport.authenticate(strategy, { session: false }, callback)(req, res, next);
    }
    if (useOpenIdStrategy && !strategyRegistered && tokenProvider === 'solid') {
      return ensureSolidJwtRegisteredLazy()
        .then((registered) => {
          if (registered && passport._strategies && passport._strategies.solidJwt) {
            return passport.authenticate('solidJwt', { session: false }, callback)(req, res, next);
          }
          return sendStrategyNotRegistered503(res, tokenProvider, true);
        })
        .catch(next);
    }
    if (useOpenIdStrategy && !strategyRegistered) {
      return sendStrategyNotRegistered503(res, tokenProvider);
    }
  }

  passport.authenticate('jwt', { session: false }, callback)(req, res, next);
};

module.exports = optionalJwtAuth;
