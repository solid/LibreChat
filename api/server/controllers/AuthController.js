const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, findOpenIDUser } = require('@librechat/api');
const {
  requestPasswordReset,
  setOpenIDAuthTokens,
  resetPassword,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const {
  deleteAllUserSessions,
  getUserById,
  findSession,
  updateUser,
  findUser,
} = require('~/models');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { getOpenIdConfig, getSolidOpenIdConfig } = require('~/strategies');

const registrationController = async (req, res) => {
  try {
    const response = await registerUser(req.body);
    const { status, message } = response;
    res.status(status).send({ message });
  } catch (err) {
    logger.error('[registrationController]', err);
    return res.status(500).json({ message: err.message });
  }
};

const resetPasswordRequestController = async (req, res) => {
  try {
    const resetService = await requestPasswordReset(req);
    if (resetService instanceof Error) {
      return res.status(400).json(resetService);
    } else {
      return res.status(200).json(resetService);
    }
  } catch (e) {
    logger.error('[resetPasswordRequestController]', e);
    return res.status(400).json({ message: e.message });
  }
};

const resetPasswordController = async (req, res) => {
  try {
    const resetPasswordService = await resetPassword(
      req.body.userId,
      req.body.token,
      req.body.password,
    );
    if (resetPasswordService instanceof Error) {
      return res.status(400).json(resetPasswordService);
    } else {
      await deleteAllUserSessions({ userId: req.body.userId });
      return res.status(200).json(resetPasswordService);
    }
  } catch (e) {
    logger.error('[resetPasswordController]', e);
    return res.status(400).json({ message: e.message });
  }
};

/**
 * Shared OpenID/Solid refresh flow: exchange refresh token for new tokenset, find user, update session, return token and user.
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Object} openIdConfig - Issuer config from getOpenIdConfig() or getSolidOpenIdConfig()
 * @param {string} refreshToken - Refresh token from session or cookie
 * @param {Record<string, string>} [refreshParams] - Optional params for token endpoint (e.g. { scope: process.env.SOLID_OPENID_SCOPE })
 * @param {string} [tokenProvider] - 'solid' or 'openid' from cookie so setOpenIDAuthTokens sets the correct token_provider cookie
 * @returns {Promise<boolean>} True if response was sent, false if caller should continue to next handler
 */
async function performOpenIDRefresh(req, res, openIdConfig, refreshToken, refreshParams = {}, tokenProvider) {
  try {
    const tokenset = await openIdClient.refreshTokenGrant(
      openIdConfig,
      refreshToken,
      Object.keys(refreshParams).length ? refreshParams : undefined,
    );
    const claims = tokenset.claims();
    const { user, error, migration } = await findOpenIDUser({
      findUser,
      email: claims.email,
      openidId: claims.sub,
      idOnTheSource: claims.oid,
      strategyName: 'refreshController',
    });

    logger.debug(
      `[refreshController] findOpenIDUser result: user=${user?.email ?? 'null'}, error=${error ?? 'null'}, migration=${migration}, userOpenidId=${user?.openidId ?? 'null'}, claimsSub=${claims.sub}`,
    );

    if (error || !user) {
      logger.warn(
        `[refreshController] Redirecting to /login: error=${error ?? 'null'}, user=${user ? 'exists' : 'null'}`,
      );
      res.status(401).redirect('/login');
      return true;
    }

    if (migration || user.openidId !== claims.sub) {
      const reason = migration ? 'migration' : 'openidId mismatch';
      await updateUser(user._id.toString(), {
        provider: user.provider || 'openid',
        openidId: claims.sub,
      });
      logger.info(
        `[refreshController] Updated user ${user.email} openidId (${reason}): ${user.openidId ?? 'null'} -> ${claims.sub}`,
      );
    }

    // setOpenIDAuthTokens sets token_provider cookie correctly (solid vs openid)
    req.user = user;
    if (tokenProvider) {
      user.provider = user.provider || tokenProvider;
    }

    const token = setOpenIDAuthTokens(tokenset, req, res, user._id.toString(), refreshToken);

    user.federatedTokens = {
      access_token: tokenset.access_token,
      id_token: tokenset.id_token,
      refresh_token: tokenset.refresh_token ?? refreshToken,
      expires_at: claims.exp,
    };

    res.status(200).send({ token, user });
    return true;
  } catch (error) {
    logger.error('[refreshController] OpenID token refresh error', error);
    return false;
  }
}

const refreshController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const token_provider = parsedCookies.token_provider;

  // Handle OpenID or Solid users with OPENID_REUSE_TOKENS enabled
  const useOpenIDRefresh =
    (token_provider === 'openid' || token_provider === 'solid') &&
    isEnabled(process.env.OPENID_REUSE_TOKENS);

  if (useOpenIDRefresh) {
    const refreshToken = req.session?.openidTokens?.refreshToken || parsedCookies.refreshToken;

    if (!refreshToken) {
      // No refresh token (e.g. Solid IdP didn't return one) but we may have a valid session from the OAuth callback
      const sessionToken =
        req.session?.openidTokens?.idToken || req.session?.openidTokens?.accessToken;
      if (sessionToken) {
        try {
          const payload = jwt.decode(sessionToken);
          const sub = payload?.sub;
          if (sub) {
            const { user, error } = await findOpenIDUser({
              findUser,
              email: payload.email,
              openidId: sub,
              idOnTheSource: payload.oid,
              strategyName: 'refreshController',
            });
            if (!error && user) {
              const token = sessionToken;
              logger.debug(
                '[refreshController] Returning token from session (no refresh token available)',
              );
              return res.status(200).send({ token, user });
            }
          }
        } catch (err) {
          logger.debug('[refreshController] Session token decode/lookup failed', err.message);
        }
      }
      logger.warn(
        '[refreshController] No OpenID refresh token available, falling back to standard refresh',
      );
      return res.status(200).send('Refresh token not provided');
    }

    const openIdConfig =
      token_provider === 'solid'
        ? (() => {
            try {
              return getSolidOpenIdConfig();
            } catch (e) {
              logger.warn('[refreshController] Solid OpenID config not initialized', {
                message: e?.message,
              });
              return null;
            }
          })()
        : (() => {
            try {
              return getOpenIdConfig();
            } catch (e) {
              logger.warn('[refreshController] OpenID config not initialized', { message: e?.message });
              return null;
            }
          })();

    if (!openIdConfig) {
      const sessionToken =
        req.session?.openidTokens?.idToken || req.session?.openidTokens?.accessToken;
      if (sessionToken) {
        try {
          const payload = jwt.decode(sessionToken);
          const sub = payload?.sub;
          if (sub) {
            const { user, error } = await findOpenIDUser({
              findUser,
              email: payload.email,
              openidId: sub,
              idOnTheSource: payload.oid,
              strategyName: 'refreshController',
            });
            if (!error && user) {
              return res.status(200).send({ token: sessionToken, user });
            }
          }
        } catch (err) {
          logger.debug('[refreshController] Session token decode/lookup failed', err.message);
        }
      }
      return res.status(200).send('Refresh token not provided');
    }

    let refreshParams = {};
    if (token_provider === 'solid' && process.env.SOLID_OPENID_SCOPE) {
      refreshParams = { scope: process.env.SOLID_OPENID_SCOPE };
    } else if (process.env.OPENID_SCOPE) {
      refreshParams = { scope: process.env.OPENID_SCOPE };
    }

    const sent = await performOpenIDRefresh(
      req,
      res,
      openIdConfig,
      refreshToken,
      refreshParams,
      token_provider,
    );
    if (sent) return;
  }

  /** For non-OpenID users or OpenID users without OPENID_REUSE_TOKENS, use standard JWT refresh */

  /** For non-OpenID users, read refresh token from cookies */
  const refreshToken = parsedCookies.refreshToken;
  if (!refreshToken) {
    return res.status(200).send('Refresh token not provided');
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await getUserById(payload.id, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      return res.status(401).redirect('/login');
    }

    const userId = payload.id;

    if (process.env.NODE_ENV === 'CI') {
      const token = await setAuthTokens(userId, res);
      return res.status(200).send({ token, user });
    }

    /** Session with the hashed refresh token */
    const session = await findSession(
      {
        userId: userId,
        refreshToken: refreshToken,
      },
      { lean: false },
    );

    if (session && session.expiration > new Date()) {
      const token = await setAuthTokens(userId, res, session);

      res.status(200).send({ token, user });
    } else if (req?.query?.retry) {
      // Retrying from a refresh token request that failed (401)
      res.status(403).send('No session found');
    } else if (payload.exp < Date.now() / 1000) {
      res.status(403).redirect('/login');
    } else {
      res.status(401).send('Refresh token expired or not found for this user');
    }
  } catch (err) {
    logger.error(`[refreshController] Invalid refresh token:`, err);
    res.status(403).send('Invalid refresh token');
  }
};

const graphTokenController = async (req, res) => {
  try {
    // Validate user is authenticated via Entra ID
    if (!req.user.openidId || req.user.provider !== 'openid') {
      return res.status(403).json({
        message: 'Microsoft Graph access requires Entra ID authentication',
      });
    }

    // Check if OpenID token reuse is active (required for on-behalf-of flow)
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return res.status(403).json({
        message: 'SharePoint integration requires OpenID token reuse to be enabled',
      });
    }

    const scopes = req.query.scopes;
    if (!scopes) {
      return res.status(400).json({
        message: 'Graph API scopes are required as query parameter',
      });
    }

    const accessToken = req.user.federatedTokens?.access_token;
    if (!accessToken) {
      return res.status(401).json({
        message: 'No federated access token available for token exchange',
      });
    }

    const tokenResponse = await getGraphApiToken(req.user, accessToken, scopes);

    res.json(tokenResponse);
  } catch (error) {
    logger.error('[graphTokenController] Failed to obtain Graph API token:', error);
    res.status(500).json({
      message: 'Failed to obtain Microsoft Graph token',
    });
  }
};

module.exports = {
  refreshController,
  registrationController,
  resetPasswordController,
  resetPasswordRequestController,
  graphTokenController,
};
