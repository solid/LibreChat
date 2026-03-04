// file deepcode ignore NoRateLimitingForLogin: Rate limiting is handled by the `loginLimiter` middleware
const express = require('express');
const passport = require('passport');
const { randomState } = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const { createSetBalanceConfig, isEnabled } = require('@librechat/api');
const { checkDomainAllowed, loginLimiter, logHeaders, checkBan } = require('~/server/middleware');
const { createOAuthHandler: _createOAuthHandler } = require('~/server/controllers/auth/oauth');
const {
  startSolidOpenIdFlow,
  handleSolidOpenIdCallback,
} = require('~/server/controllers/auth/solidOpenIdDynamic');
const { setAuthTokens, setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { startBaseStructureAfterLogin } = require('~/server/services/SolidStorage');
const { getAppConfig } = require('~/server/services/Config');
const { Balance } = require('~/db/models');

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
      (req.user.provider === 'openid' || req.user.provider === 'solid') &&
      // isEnabled(process.env.OPENID_REUSE_TOKENS) === true
      req.user.tokenset &&
      req.user.tokenset.access_token
    ) {
      // Always store OpenID tokens in session (needed for Solid Pod access)
      setOpenIDAuthTokens(req.user.tokenset, req, res, req.user._id.toString());
      logger.info('[oauthHandler] OpenID tokens stored for Solid Pod access', {
        userId: req.user._id.toString(),
        hasAccessToken: !!req.user.tokenset.access_token,
        hasRefreshToken: !!req.user.tokenset.refresh_token,
      });

      // Also create JWT tokens for frontend authentication
      // OPENID_REUSE_TOKENS determines if we use OpenID JWT or standard JWT
      if (isEnabled(process.env.OPENID_REUSE_TOKENS) === true) {
        await syncUserEntraGroupMemberships(req.user, req.user.tokenset.access_token);
        // When OPENID_REUSE_TOKENS is enabled, setOpenIDAuthTokens handles JWT creation
        // via the openidJwt strategy, so we don't need to call setAuthTokens
      } else {
        // When OPENID_REUSE_TOKENS is disabled, create standard JWT tokens
        await setAuthTokens(req.user._id, res);
      }
      // Ensure Solid Pod base structure in background so writes don't call it every time (baton)
      if (req.user.openidId) {
        startBaseStructureAfterLogin(req).catch((err) =>
          logger.warn('[oauthHandler] Solid base structure init after login failed', {
            openidId: req.user.openidId,
            error: err?.message,
          }),
        );
      }
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
  const errorMessage = req.session?.messages?.pop() || 'Unknown OAuth error';
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
 * When ?issuer= is present, use dynamic Solid multi-issuer flow; otherwise Passport (single-issuer or generic OpenID).
 */
router.get('/openid', startSolidOpenIdFlow, (req, res, next) => {
  return passport.authenticate('openid', {
    session: false,
    state: randomState(),
  })(req, res, next);
});

/**
 * Middleware to log authorization code from Solid/OpenID provider
 */
const logAuthorizationCode = (req, res, next) => {
  const { code, state, error } = req.query;

  if (code) {
    logger.info('[OpenID Callback] Authorization code received from Solid provider', {
      authorizationCode: code,
      state: state || 'not provided',
      hasError: !!error,
      error: error || null,
      queryParams: {
        code: code ? 'present' : 'missing',
        state: state || 'missing',
        error: error || 'none',
      },
    });
    logger.info(`[OpenID Callback] Full authorization code: ${code}`);
  } else if (error) {
    logger.warn('[OpenID Callback] OAuth error received (no authorization code)', {
      error,
      error_description: req.query.error_description,
      state: state || 'not provided',
    });
  } else {
    logger.warn('[OpenID Callback] No authorization code or error in callback', {
      queryParams: req.query,
    });
  }

  next();
};

router.get(
  '/openid/callback',
  logAuthorizationCode,
  handleSolidOpenIdCallback,
  (req, res, next) => {
    if (req.user) {
      return next();
    }
    return passport.authenticate('openid', {
      failureRedirect: `${domains.client}/oauth/error`,
      failureMessage: true,
      session: false,
    })(req, res, next);
  },
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

module.exports = router;
