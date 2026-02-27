const passport = require('passport');
const session = require('express-session');
const { CacheKeys } = require('librechat-data-provider');
const { isEnabled, shouldUseSecureCookie } = require('@librechat/api');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  openIdJwtLogin,
  facebookLogin,
  discordLogin,
  setupSolidOpenIdFromProvider,
  setupOpenId,
  googleLogin,
  githubLogin,
  appleLogin,
  setupSaml,
} = require('~/strategies');
const { getLogStores } = require('~/cache');
const {
  getSolidOpenIdProvidersForJwt,
  isSolidOpenIdEnabled,
} = require('./services/Config/solidOpenId');
const { ensureSolidJwtRegistered } = require('./services/ensureSolidJwt');

/**
 * Registers solidJwt and sets OpenID config from the first Solid provider only (no session).
 * Use when Solid providers exist but we didn't run configureSolidOpenId/configureSolidOpenIdFromProviders
 * (e.g. session already added by generic OpenID). Ensures API requests with token_provider=solid succeed.
 * @returns {Promise<void>}
 */
async function registerSolidJwtFromProviders() {
  const providers = getSolidOpenIdProvidersForJwt();
  if (providers.length === 0) {
    logger.debug('[registerSolidJwtFromProviders] No Solid providers configured - skipping.');
    return;
  }
  const config = await setupSolidOpenIdFromProvider(providers[0]);
  if (!config) {
    logger.warn(
      '[registerSolidJwtFromProviders] Discovery for first provider failed - solidJwt not registered. Ensure the Solid IdP (e.g. Local CSS) is running at startup.',
      { issuer: providers[0].issuer },
    );
    return;
  }
  if (passport._strategies && passport._strategies.solidJwt) {
    return;
  }
  passport.use('solidJwt', openIdJwtLogin(config));
  logger.info('Solid OpenID: solidJwt registered from first provider (post-login API auth).');
}

/** Wrapper for startup: use shared ensureSolidJwtRegistered when we need a final pass */
async function ensureSolidJwtFromProvidersOnce() {
  await ensureSolidJwtRegistered();
}

/**
 * Configures Solid session and solidJwt when only SOLID_OPENID_PROVIDERS is set (no legacy single-issuer env).
 * Also supports SOLID_OPENID_CUSTOM_CLIENT_ID-only: uses synthetic Local CSS provider for JWT registration.
 * Ensures getSolidOpenIdConfig() and solidJwt work so post-login API requests and refresh succeed.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureSolidOpenIdFromProviders(app) {
  const providers = getSolidOpenIdProvidersForJwt();
  if (providers.length === 0) {
    return;
  }
  logger.info('Configuring Solid OpenID from providers (session + JWT for post-login)...');
  const sessionOptions = {
    secret: process.env.SOLID_OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  const config = await setupSolidOpenIdFromProvider(providers[0]);
  if (!config) {
    logger.warn(
      '[configureSolidOpenIdFromProviders] Discovery for first provider failed - solidJwt not registered.',
    );
    return;
  }
  passport.use('solidJwt', openIdJwtLogin(config));
  if (isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.info('Solid OpenID token reuse enabled (solidJwt registered from first provider).');
  }
  logger.info('Solid OpenID from providers configured (session + solidJwt).');
}

/**
 * Configures generic OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureOpenId(app) {
  logger.info('Configuring OpenID Connect...');
  const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;
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
  // Solid: dynamic providers only (SOLID_OPENID_PROVIDERS or SOLID_OPENID_CUSTOM_CLIENT_ID). Session + solidJwt from first provider.
  const solidProvidersForJwt = getSolidOpenIdProvidersForJwt();
  if (process.env.SOLID_OPENID_SESSION_SECRET && solidProvidersForJwt.length > 0) {
    await configureSolidOpenIdFromProviders(app);
  } else if (solidProvidersForJwt.length > 0) {
    await registerSolidJwtFromProviders();
  }
  // Ensure solidJwt is registered whenever Solid is enabled (e.g. discovery failed earlier or IdP was down at startup)
  if (isSolidOpenIdEnabled() && (!passport._strategies || !passport._strategies.solidJwt)) {
    await ensureSolidJwtFromProvidersOnce();
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
