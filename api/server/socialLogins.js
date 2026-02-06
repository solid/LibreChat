const passport = require('passport');
const session = require('express-session');
const { CacheKeys } = require('librechat-data-provider');
const { isEnabled, shouldUseSecureCookie } = require('@librechat/api');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  openIdJwtLogin,
  facebookLogin,
  discordLogin,
  setupSolidOpenId,
  setupOpenId,
  googleLogin,
  githubLogin,
  appleLogin,
  setupSaml,
} = require('~/strategies');
const { getLogStores } = require('~/cache');


/**
 * Configures Solid OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureSolidOpenId(app) {
  logger.info('Configuring Solid OpenID Connect...');
  const sessionOptions = {
    secret: process.env.SOLID_OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  const config = await setupSolidOpenId();
  if (!config) {
    logger.error('Solid OpenID Connect configuration failed - strategy not registered.');
    return;
  }

  if (isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.info('Solid OpenID token reuse is enabled.');
    passport.use('solidJwt', openIdJwtLogin(config));
  }
  logger.info('Solid OpenID Connect configured successfully.');
}

/**
* Configures Solid OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureSolidOpenId(app) {
  logger.info('Configuring Solid OpenID Connect...');
  const sessionOptions = {
    secret: process.env.SOLID_OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  const config = await setupSolidOpenId();
  if (!config) {
    logger.error('Solid OpenID Connect configuration failed - strategy not registered.');
    return;
  }

  if (isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.info('Solid OpenID token reuse is enabled.');
    passport.use('solidJwt', openIdJwtLogin(config));
  }
  logger.info('Solid OpenID Connect configured successfully.');
}

/**
 * Configures generic OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureOpenId(app) {
  logger.info('Configuring OpenID Connect...');
  const sessionOptions = {
    secret: process.env.SOLID_OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
    cookie: {
      maxAge: sessionExpiry,
      secure: shouldUseSecureCookie(),
    },
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  const config = await setupOpenId();
  if (!config) {
    logger.error('OpenID Connect configuration failed - strategy not registered.');
    return;
  }

  if (isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.info('OpenID token reuse is enabled.');
    passport.use('openidJwt', openIdJwtLogin(config));
  }
  logger.info('OpenID Connect configured successfully.');
}

/**
 *
 * @param {Express.Application} app
 */
const configureSocialLogins = async (app) => {
  logger.info('Configuring social logins...');

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(googleLogin());
  }
  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    passport.use(facebookLogin());
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(githubLogin());
  }
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use(discordLogin());
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
    passport.use(appleLogin());
  }
  // Configure Solid OpenID if SOLID_OPENID_* env vars are present
  if (
    process.env.SOLID_OPENID_CLIENT_ID &&
    process.env.SOLID_OPENID_ISSUER &&
    process.env.SOLID_OPENID_SCOPE &&
    process.env.SOLID_OPENID_SESSION_SECRET
  ) {
    await configureSolidOpenId(app);
  }
  // Configure generic OpenID if OPENID_* env vars are present
  if (
    process.env.OPENID_CLIENT_ID &&
    process.env.OPENID_ISSUER &&
    process.env.OPENID_SCOPE &&
    process.env.OPENID_SESSION_SECRET
  ) {
    await configureOpenId(app);
  }
  if (
    process.env.SAML_ENTRY_POINT &&
    process.env.SAML_ISSUER &&
    process.env.SAML_CERT &&
    process.env.SAML_SESSION_SECRET
  ) {
    logger.info('Configuring SAML Connect...');
    const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;
    const sessionOptions = {
      secret: process.env.SAML_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: getLogStores(CacheKeys.SAML_SESSION),
      cookie: {
        maxAge: sessionExpiry,
        secure: shouldUseSecureCookie(),
      },
    };
    app.use(session(sessionOptions));
    app.use(passport.session());
    setupSaml();

    logger.info('SAML Connect configured.');
  }
};

module.exports = configureSocialLogins;
