const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');

// This middleware does not require authentication,
// but if the user is authenticated, it will set the user object.
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
  if (
    (tokenProvider === 'openid' || tokenProvider === 'solid') &&
    isEnabled(process.env.OPENID_REUSE_TOKENS)
  ) {
    const strategy = tokenProvider === 'solid' ? 'solidJwt' : 'openidJwt';
    return passport.authenticate(strategy, { session: false }, callback)(req, res, next);
  }
  passport.authenticate('jwt', { session: false }, callback)(req, res, next);
};

module.exports = optionalJwtAuth;
