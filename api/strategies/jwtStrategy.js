const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const cookies = require('cookie');
const { getUserById, updateUser } = require('~/models');

// Custom JWT extractor that checks both Authorization header and cookies
const jwtExtractor = (req) => {
  // Try Authorization header first (standard way)
  const authHeader = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (authHeader) {
    logger.debug('[jwtStrategy] JWT extracted from Authorization header');
    return authHeader;
  }

  // Fallback: Try to extract from cookies (for browser direct access)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const parsedCookies = cookies.parse(cookieHeader);
    // Check for token in cookies (some implementations store it here)
    if (parsedCookies.token) {
      logger.debug('[jwtStrategy] JWT extracted from cookie');
      return parsedCookies.token;
    }
  }

  logger.debug('[jwtStrategy] No JWT found in Authorization header or cookies');
  return null;
};

// JWT strategy
const jwtLogin = () =>
  new JwtStrategy(
    {
      jwtFromRequest: jwtExtractor,
      secretOrKey: process.env.JWT_SECRET,
    },
    async (payload, done) => {
      try {
        const user = await getUserById(payload?.id, '-password -__v -totpSecret -backupCodes');
        if (user) {
          user.id = user._id.toString();
          if (!user.role) {
            user.role = SystemRoles.USER;
            await updateUser(user.id, { role: user.role });
          }
          done(null, user);
        } else {
          logger.warn('[jwtLogin] JwtStrategy => no user found: ' + payload?.id);
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );

module.exports = jwtLogin;
