// file deepcode ignore NoRateLimitingForLogin: Rate limiting is handled by the `loginLimiter` middleware
const express = require('express');
const passport = require('passport');
const { randomState } = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const { isEnabled, createSetBalanceConfig } = require('@librechat/api');
const { checkDomainAllowed, loginLimiter, logHeaders, checkBan } = require('~/server/middleware');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens, setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { getAppConfig } = require('~/server/services/Config');
const { Balance } = require('~/db/models');
const solidStrategy = require('~/strategies/solidStrategy');

const setBalanceConfig = createSetBalanceConfig({
  getAppConfig,
  Balance,
});

const router = express.Router();

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

router.use(logHeaders);
router.use(loginLimiter);

const oauthHandler = async (req, res, next) => {
  try {
    if (res.headersSent) {
      return;
    }

    await checkBan(req, res);
    if (req.banned) {
      return;
    }
    if (
      req.user &&
      req.user.provider == 'openid' &&
      isEnabled(process.env.OPENID_REUSE_TOKENS) === true
    ) {
      await syncUserEntraGroupMemberships(req.user, req.user.tokenset.access_token);
      setOpenIDAuthTokens(req.user.tokenset, res, req.user._id.toString());
    } else {
      await setAuthTokens(req.user._id, res);
    }
    res.redirect(domains.client);
  } catch (err) {
    logger.error('Error in setting authentication tokens:', err);
    next(err);
  }
};

router.get('/error', (req, res) => {
  /** A single error message is pushed by passport when authentication fails. */
  const errorMessage = req.session?.messages?.pop() || 'Unknown error';
  logger.error('Error in OAuth authentication:', {
    message: errorMessage,
  });

  res.redirect(`${domains.client}/login?redirect=false&error=${ErrorTypes.AUTH_FAILED}`);
});

/**
 * Google Routes
 */
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['openid', 'profile', 'email'],
    session: false,
  }),
);

router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
    scope: ['openid', 'profile', 'email'],
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * Facebook Routes
 */
router.get(
  '/facebook',
  passport.authenticate('facebook', {
    scope: ['public_profile'],
    profileFields: ['id', 'email', 'name'],
    session: false,
  }),
);

router.get(
  '/facebook/callback',
  passport.authenticate('facebook', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
    scope: ['public_profile'],
    profileFields: ['id', 'email', 'name'],
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * OpenID Routes
 */
router.get('/openid', (req, res, next) => {
  return passport.authenticate('openid', {
    session: false,
    state: randomState(),
  })(req, res, next);
});

router.get(
  '/openid/callback',
  passport.authenticate('openid', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * GitHub Routes
 */
router.get(
  '/github',
  passport.authenticate('github', {
    scope: ['user:email', 'read:user'],
    session: false,
  }),
);

router.get(
  '/github/callback',
  passport.authenticate('github', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
    scope: ['user:email', 'read:user'],
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * Discord Routes
 */
router.get(
  '/discord',
  passport.authenticate('discord', {
    scope: ['identify', 'email'],
    session: false,
  }),
);

router.get(
  '/discord/callback',
  passport.authenticate('discord', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
    scope: ['identify', 'email'],
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * Apple Routes
 */
router.get(
  '/apple',
  passport.authenticate('apple', {
    session: false,
  }),
);

router.post(
  '/apple/callback',
  passport.authenticate('apple', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
  }),
  setBalanceConfig,
  checkDomainAllowed,
  oauthHandler,
);

/**
 * SAML Routes
 */
router.get(
  '/saml',
  passport.authenticate('saml', {
    session: false,
  }),
);

router.post(
  '/saml/callback',
  passport.authenticate('saml', {
    failureRedirect: `${domains.client}/oauth/error`,
    failureMessage: true,
    session: false,
  }),
  oauthHandler,
);

/**
 * Solid OIDC Routes
 *
 * Solid requires dynamic issuer discovery since users can choose their pod provider.
 * The issuer URL is passed as a query parameter and validated against allowed issuers.
 */

/**
 * Client Identifier Document endpoint
 * Required by Solid-OIDC when using a URL as client_id
 * @see https://solidproject.org/TR/oidc#clientids-document
 */
router.get('/solid/client-id', (req, res) => {
  const clientId = `${process.env.DOMAIN_SERVER}/oauth/solid/client-id`;
  const redirectUri = `${process.env.DOMAIN_SERVER}/oauth/solid/callback`;
  
  const clientDocument = {
    '@context': 'https://www.w3.org/ns/solid/oidc-context.jsonld',
    'client_id': clientId,
    'client_name': 'LibreChat',
    'redirect_uris': [redirectUri],
    'client_uri': domains.client,
    'scope': 'openid webid offline_access',
    'grant_types': ['authorization_code', 'refresh_token'],
    'response_types': ['code'],
  };

  res.setHeader('Content-Type', 'application/ld+json');
  res.json(clientDocument);
});

router.get('/solid', async (req, res) => {
  try {
    const { issuer } = req.query;

    if (!issuer) {
      logger.warn('[oauth/solid] No issuer provided');
      return res.redirect(`${domains.client}/login?error=solid_no_issuer`);
    }

    // Validate issuer URL
    try {
      new URL(issuer);
    } catch {
      logger.warn(`[oauth/solid] Invalid issuer URL: ${issuer}`);
      return res.redirect(`${domains.client}/login?error=solid_invalid_issuer`);
    }

    // Get authorization URL
    const result = await solidStrategy.getAuthorizationUrl(issuer);
    if (!result) {
      logger.error(`[oauth/solid] Failed to get auth URL for issuer: ${issuer}`);
      return res.redirect(`${domains.client}/login?error=solid_discovery_failed`);
    }

    logger.info(`[oauth/solid] Redirecting to Solid provider: ${issuer}`);
    res.redirect(result.authUrl);
  } catch (error) {
    logger.error('[oauth/solid] Error initiating Solid auth:', error);
    res.redirect(`${domains.client}/login?error=${ErrorTypes.AUTH_FAILED}`);
  }
});

router.get('/solid/callback', async (req, res, next) => {
  try {
    const { code, state, error: oauthError, error_description } = req.query;

    // Handle OAuth errors from provider
    if (oauthError) {
      logger.error(`[oauth/solid/callback] OAuth error: ${oauthError} - ${error_description}`);
      return res.redirect(`${domains.client}/login?error=${ErrorTypes.AUTH_FAILED}`);
    }

    if (!code || !state) {
      logger.warn('[oauth/solid/callback] Missing code or state');
      return res.redirect(`${domains.client}/login?error=${ErrorTypes.AUTH_FAILED}`);
    }

    // Check ban status
    await checkBan(req, res);
    if (req.banned) {
      return;
    }

    // Handle the callback
    const result = await solidStrategy.handleCallback(code, state);

    if (result.error) {
      logger.error(`[oauth/solid/callback] ${result.error}`);
      return res.redirect(`${domains.client}/login?error=${ErrorTypes.AUTH_FAILED}`);
    }

    // Set the user on request for downstream handlers
    req.user = result.user;

    // Set auth tokens and redirect
    await setAuthTokens(req.user._id, res);
    logger.info(`[oauth/solid/callback] Redirecting to: ${domains.client}`);
    res.redirect(domains.client);
  } catch (error) {
    logger.error('[oauth/solid/callback] Error:', error);
    res.redirect(`${domains.client}/login?error=${ErrorTypes.AUTH_FAILED}`);
  }
});

/**
 * Solid providers endpoint - returns list of available Solid providers
 * Used by frontend to display provider selection
 */
router.get('/solid/providers', (req, res) => {
  const providers = solidStrategy.getAvailableProviders();
  const allowCustom = isEnabled(process.env.SOLID_ALLOW_ANY_ISSUER);
  res.json({ providers, allowCustom });
});

module.exports = router;
