const undici = require('undici');
const { get } = require('lodash');
const fetch = require('node-fetch');
const passport = require('passport');
const client = require('openid-client');
const jwtDecode = require('jsonwebtoken/decode');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { hashToken, logger } = require('@librechat/data-schemas');
const { CacheKeys, ErrorTypes } = require('librechat-data-provider');
const { Strategy: OpenIDStrategy } = require('openid-client/passport');
const {
  isEnabled,
  logHeaders,
  safeStringify,
  findOpenIDUser,
  getBalanceConfig,
  isEmailDomainAllowed,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { findUser, createUser, updateUser } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const getLogStores = require('~/cache/getLogStores');

/**
 * @typedef {import('openid-client').ClientMetadata} ClientMetadata
 * @typedef {import('openid-client').Configuration} Configuration
 **/

/**
 * @param {string} url
 * @param {client.CustomFetchOptions} options
 */
async function customFetch(url, options) {
  const urlStr = url.toString();
  logger.debug(`[SolidOpenidStrategy] Request to: ${urlStr}`);
  const debugOpenId = isEnabled(process.env.DEBUG_OPENID_REQUESTS);
  if (debugOpenId) {
    logger.debug(`[SolidOpenidStrategy] Request method: ${options.method || 'GET'}`);
    logger.debug(`[SolidOpenidStrategy] Request headers: ${logHeaders(options.headers)}`);
    if (options.body) {
      let bodyForLogging = '';
      if (options.body instanceof URLSearchParams) {
        bodyForLogging = options.body.toString();
      } else if (typeof options.body === 'string') {
        bodyForLogging = options.body;
      } else {
        bodyForLogging = safeStringify(options.body);
      }
      logger.debug(`[SolidOpenidStrategy] Request body: ${bodyForLogging}`);
    }
  }

  try {
    /** @type {undici.RequestInit} */
    let fetchOptions = options;
    if (process.env.PROXY) {
      logger.info(`[SolidOpenidStrategy] proxy agent configured: ${process.env.PROXY}`);
      fetchOptions = {
        ...options,
        dispatcher: new undici.ProxyAgent(process.env.PROXY),
      };
    }

    const response = await undici.fetch(url, fetchOptions);

    if (debugOpenId) {
      logger.debug(
        `[SolidOpenidStrategy] Response status: ${response.status} ${response.statusText}`,
      );
      logger.debug(`[SolidOpenidStrategy] Response headers: ${logHeaders(response.headers)}`);
    }

    if (response.status === 200 && response.headers.has('www-authenticate')) {
      const wwwAuth = response.headers.get('www-authenticate');
      logger.warn(`[SolidOpenidStrategy] Non-standard WWW-Authenticate header found in successful response (200 OK): ${wwwAuth}.
This violates RFC 7235 and may cause issues with strict OAuth clients. Removing header for compatibility.`);

      /** Cloned response without the WWW-Authenticate header */
      const responseBody = await response.arrayBuffer();
      const newHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() !== 'www-authenticate') {
          newHeaders.append(key, value);
        }
      }

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return response;
  } catch (error) {
    logger.error(`[SolidOpenidStrategy] Fetch error: ${error.message}`);
    throw error;
  }
}

/** @typedef {Configuration | null}  */
let openidConfig = null;

/**
 * Custom OpenID Strategy
 *
 * Note: Originally overrode currentUrl() to work around Express 4's req.host not including port.
 * With Express 5, req.host now includes the port by default, but we continue to use DOMAIN_SERVER
 * for consistency and explicit configuration control.
 * More info: https://github.com/panva/openid-client/pull/713
 */
class CustomOpenIDStrategy extends OpenIDStrategy {
  currentUrl(req) {
    const hostAndProtocol = process.env.DOMAIN_SERVER;
    return new URL(`${hostAndProtocol}${req.originalUrl ?? req.url}`);
  }

  authorizationRequestParams(req, options) {
    const params = super.authorizationRequestParams(req, options);
    if (options?.state && !params.has('state')) {
      params.set('state', options.state);
    }

    if (process.env.OPENID_AUDIENCE) {
      params.set('audience', process.env.OPENID_AUDIENCE);
      logger.debug(
        `[SolidOpenidStrategy] Adding audience to authorization request: ${process.env.OPENID_AUDIENCE}`,
      );
    }

    /** Generate nonce for federated providers that require it */
    const shouldGenerateNonce = isEnabled(process.env.OPENID_GENERATE_NONCE);
    if (shouldGenerateNonce && !params.has('nonce') && this._sessionKey) {
      const crypto = require('crypto');
      const nonce = crypto.randomBytes(16).toString('hex');
      params.set('nonce', nonce);
      logger.debug('[SolidOpenidStrategy] Generated nonce for federated provider:', nonce);
    }

    /** Request consent so CSS/node-oidc-provider issues a refresh_token when offline_access is in scope */
    if (!params.has('prompt')) {
      params.set('prompt', 'consent');
    }

    return params;
  }
}

/**
 * Exchange the access token for a new access token using the on-behalf-of flow if required.
 * @param {Configuration} config
 * @param {string} accessToken access token to be exchanged if necessary
 * @param {string} sub - The subject identifier of the user. usually found as "sub" in the claims of the token
 * @param {boolean} fromCache - Indicates whether to use cached tokens.
 * @returns {Promise<string>} The new access token if exchanged, otherwise the original access token.
 */
const exchangeAccessTokenIfNeeded = async (config, accessToken, sub, fromCache = false) => {
  const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);
  const onBehalfFlowRequired = isEnabled(process.env.OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED);
  if (onBehalfFlowRequired) {
    if (fromCache) {
      const cachedToken = await tokensCache.get(sub);
      if (cachedToken) {
        return cachedToken.access_token;
      }
    }
    const grantResponse = await client.genericGrantRequest(
      config,
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: process.env.OPENID_ON_BEHALF_FLOW_USERINFO_SCOPE || 'user.read',
        assertion: accessToken,
        requested_token_use: 'on_behalf_of',
      },
    );
    await tokensCache.set(
      sub,
      {
        access_token: grantResponse.access_token,
      },
      grantResponse.expires_in * 1000,
    );
    return grantResponse.access_token;
  }
  return accessToken;
};

/**
 * get user info from openid provider
 * @param {Configuration} config
 * @param {string} accessToken access token
 * @param {string} sub - The subject identifier of the user. usually found as "sub" in the claims of the token
 * @returns {Promise<Object|null>}
 */
const getUserInfo = async (config, accessToken, sub) => {
  try {
    const exchangedAccessToken = await exchangeAccessTokenIfNeeded(config, accessToken, sub);
    return await client.fetchUserInfo(config, exchangedAccessToken, sub);
  } catch (error) {
    logger.error('[SolidOpenidStrategy] getUserInfo: Error fetching user info:', error);
    return null;
  }
};

/**
 * Downloads an image from a URL using an access token.
 * @param {string} url
 * @param {Configuration} config
 * @param {string} accessToken access token
 * @param {string} sub - The subject identifier of the user. usually found as "sub" in the claims of the token
 * @returns {Promise<Buffer | string>} The image buffer or an empty string if the download fails.
 */
const downloadImage = async (url, config, accessToken, sub) => {
  const exchangedAccessToken = await exchangeAccessTokenIfNeeded(config, accessToken, sub, true);
  if (!url) {
    return '';
  }

  try {
    const options = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${exchangedAccessToken}`,
      },
    };

    if (process.env.PROXY) {
      options.agent = new HttpsProxyAgent(process.env.PROXY);
    }

    const response = await fetch(url, options);

    if (response.ok) {
      const buffer = await response.buffer();
      return buffer;
    } else {
      throw new Error(`${response.statusText} (HTTP ${response.status})`);
    }
  } catch (error) {
    logger.error(
      `[SolidOpenidStrategy] downloadImage: Error downloading image at URL "${url}": ${error}`,
    );
    return '';
  }
};

/**
 * Determines the full name of a user based on OpenID userinfo and environment configuration.
 *
 * @param {Object} userinfo - The user information object from OpenID Connect
 * @param {string} [userinfo.given_name] - The user's first name
 * @param {string} [userinfo.family_name] - The user's last name
 * @param {string} [userinfo.username] - The user's username
 * @param {string} [userinfo.email] - The user's email address
 * @returns {string} The determined full name of the user
 */
function getFullName(userinfo) {
  if (process.env.OPENID_NAME_CLAIM) {
    return userinfo[process.env.OPENID_NAME_CLAIM];
  }

  if (userinfo.given_name && userinfo.family_name) {
    return `${userinfo.given_name} ${userinfo.family_name}`;
  }

  if (userinfo.given_name) {
    return userinfo.given_name;
  }

  if (userinfo.family_name) {
    return userinfo.family_name;
  }

  return userinfo.username || userinfo.email;
}

/**
 * Converts an input into a string suitable for a username.
 * If the input is a string, it will be returned as is.
 * If the input is an array, elements will be joined with underscores.
 * In case of undefined or other falsy values, a default value will be returned.
 *
 * @param {string | string[] | undefined} input - The input value to be converted into a username.
 * @param {string} [defaultValue=''] - The default value to return if the input is falsy.
 * @returns {string} The processed input as a string suitable for a username.
 */
function convertToUsername(input, defaultValue = '') {
  if (typeof input === 'string') {
    return input;
  } else if (Array.isArray(input)) {
    return input.join('_');
  }

  return defaultValue;
}

/**
 * Verify Solid OpenID tokens and find/create user. Used by both the Passport strategy and the dynamic multi-issuer callback.
 * @param {import('openid-client').TokenEndpointResponse & import('openid-client').TokenEndpointResponseHelpers} tokenset
 * @param {Configuration} openidConfig
 * @returns {Promise<Object>} User object with tokenset and federatedTokens (same shape as Passport verify callback).
 * @throws {Error} On auth failure (email not allowed, required role missing, etc.)
 */
async function verifySolidUser(tokenset, openidConfig) {
  const requiredRole = process.env.OPENID_REQUIRED_ROLE;
  const requiredRoleParameterPath = process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH;
  const requiredRoleTokenKind = process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND;
  const adminRole = process.env.OPENID_ADMIN_ROLE;
  const adminRoleParameterPath = process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
  const adminRoleTokenKind = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND;

  const claims = tokenset.claims();
  const userinfo = {
    ...claims,
    ...(await getUserInfo(openidConfig, tokenset.access_token, claims.sub)),
  };

  const appConfig = await getAppConfig();
  const email =
    userinfo.email ||
    userinfo.preferred_username ||
    userinfo.upn ||
    `${userinfo.webid}@FAKEDOMAIN.TLD`;
  if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
    logger.error(
      `[SolidOpenidStrategy] Authentication blocked - email domain not allowed [Email: ${email}]`,
    );
    const err = new Error('Email domain not allowed');
    err.code = 'EMAIL_DOMAIN_NOT_ALLOWED';
    throw err;
  }

  const result = await findOpenIDUser({
    findUser,
    email,
    openidId: claims.sub,
    idOnTheSource: claims.oid,
    strategyName: 'SolidOpenidStrategy',
  });
  let user = result.user;
  const error = result.error;

  if (error) {
    const err = new Error(ErrorTypes.AUTH_FAILED);
    err.code = 'AUTH_FAILED';
    throw err;
  }

  const fullName = getFullName(userinfo);

  if (requiredRole) {
    const requiredRoles = requiredRole
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
    let decodedToken = '';
    if (requiredRoleTokenKind === 'access') {
      decodedToken = jwtDecode(tokenset.access_token);
    } else if (requiredRoleTokenKind === 'id') {
      decodedToken = jwtDecode(tokenset.id_token);
    }

    let roles = get(decodedToken, requiredRoleParameterPath);
    if (!roles || (!Array.isArray(roles) && typeof roles !== 'string')) {
      const rolesList =
        requiredRoles.length === 1
          ? `"${requiredRoles[0]}"`
          : `one of: ${requiredRoles.map((r) => `"${r}"`).join(', ')}`;
      throw new Error(`You must have ${rolesList} role to log in.`);
    }
    if (!requiredRoles.some((role) => roles.includes(role))) {
      const rolesList =
        requiredRoles.length === 1
          ? `"${requiredRoles[0]}"`
          : `one of: ${requiredRoles.map((r) => `"${r}"`).join(', ')}`;
      throw new Error(`You must have ${rolesList} role to log in.`);
    }
  }

  let username = '';
  if (process.env.OPENID_USERNAME_CLAIM) {
    username = userinfo[process.env.OPENID_USERNAME_CLAIM];
  } else {
    username = convertToUsername(
      userinfo.preferred_username || userinfo.username || userinfo.email,
    );
  }

  if (!user) {
    user = {
      provider: 'solid',
      openidId: userinfo.sub,
      username,
      email: email || '',
      emailVerified: userinfo.email_verified || false,
      name: fullName,
      idOnTheSource: userinfo.oid,
    };
    const balanceConfig = getBalanceConfig(appConfig);
    user = await createUser(user, balanceConfig, true, true);
  } else {
    user.provider = 'solid';
    user.openidId = userinfo.sub;
    user.username = username;
    user.name = fullName;
    user.idOnTheSource = userinfo.oid;
    if (email && email !== user.email) {
      user.email = email;
      user.emailVerified = userinfo.email_verified || false;
    }
  }

  if (adminRole && adminRoleParameterPath && adminRoleTokenKind) {
    let adminRoleObject;
    switch (adminRoleTokenKind) {
      case 'access':
        adminRoleObject = jwtDecode(tokenset.access_token);
        break;
      case 'id':
        adminRoleObject = jwtDecode(tokenset.id_token);
        break;
      case 'userinfo':
        adminRoleObject = userinfo;
        break;
      default:
        throw new Error(`Invalid admin role token kind: ${adminRoleTokenKind}`);
    }
    const adminRoles = get(adminRoleObject, adminRoleParameterPath);
    if (
      adminRoles &&
      (adminRoles === true ||
        adminRoles === adminRole ||
        (Array.isArray(adminRoles) && adminRoles.includes(adminRole)))
    ) {
      user.role = 'ADMIN';
    } else if (user.role === 'ADMIN') {
      user.role = 'USER';
    }
  }

  if (!!userinfo && userinfo.picture && !user.avatar?.includes('manual=true')) {
    const imageUrl = userinfo.picture;
    const crypto = require('crypto');
    const fileName = crypto ? (await hashToken(userinfo.sub)) + '.png' : userinfo.sub + '.png';
    const imageBuffer = await downloadImage(
      imageUrl,
      openidConfig,
      tokenset.access_token,
      userinfo.sub,
    );
    if (imageBuffer) {
      const { saveBuffer } = getStrategyFunctions(
        appConfig?.fileStrategy ?? process.env.CDN_PROVIDER,
      );
      const imagePath = await saveBuffer({
        fileName,
        userId: user._id.toString(),
        buffer: imageBuffer,
      });
      user.avatar = imagePath ?? '';
    }
  }

  user = await updateUser(user._id, user);

  logger.info(
    `[SolidOpenidStrategy] login success openidId: ${user.openidId} | email: ${user.email} | username: ${user.username}`,
  );

  return {
    ...user,
    provider: 'solid',
    tokenset,
    federatedTokens: {
      access_token: tokenset.access_token,
      refresh_token: tokenset.refresh_token,
      expires_at: tokenset.expires_at,
    },
  };
}

/**
 * Sets up the OpenID strategy for authentication.
 * This function configures the OpenID client, handles proxy settings,
 * and defines the OpenID strategy for Passport.js.
 *
 * @async
 * @function setupOpenId
 * @returns {Promise<Configuration | null>} A promise that resolves when the OpenID strategy is set up and returns the openid client config object.
 * @throws {Error} If an error occurs during the setup process.
 */
/**
 * @deprecated Use SOLID_OPENID_PROVIDERS and setupSolidOpenIdFromProvider() instead. Not used in dynamic flow.
 * Legacy single-issuer setup using SOLID_OPENID_ISSUER (no longer supported).
 * @async
 * @function setupSolidOpenId
 * @returns {Promise<Configuration | null>}
 */
async function _setupSolidOpenId() {
  try {
    const shouldGenerateNonce = isEnabled(process.env.OPENID_GENERATE_NONCE);

    /** @type {ClientMetadata} */
    const clientMetadata = {
      client_id: process.env.SOLID_OPENID_CLIENT_ID,
      client_secret: process.env.SOLID_OPENID_CLIENT_SECRET,
    };

    if (shouldGenerateNonce) {
      clientMetadata.response_types = ['code'];
      clientMetadata.grant_types = ['authorization_code'];
      clientMetadata.token_endpoint_auth_method = 'client_secret_post';
    }

    /** @type {Configuration} */
    openidConfig = await client.discovery(
      new URL(process.env.SOLID_OPENID_ISSUER),
      process.env.SOLID_OPENID_CLIENT_ID,
      clientMetadata,
      undefined,
      {
        [client.customFetch]: customFetch,
        execute: [client.allowInsecureRequests], // TODO: Insecure! Remove deprecated hack used for local HTTP only.
      },
    );

    const _requiredRole = process.env.OPENID_REQUIRED_ROLE;
    const _requiredRoleParameterPath = process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH;
    const _requiredRoleTokenKind = process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND;
    const usePKCE = isEnabled(process.env.OPENID_USE_PKCE);
    logger.info(`[SolidOpenidStrategy] OpenID authentication configuration`, {
      generateNonce: shouldGenerateNonce,
      reason: shouldGenerateNonce
        ? 'OPENID_GENERATE_NONCE=true - Will generate nonce and use explicit metadata for federated providers'
        : 'OPENID_GENERATE_NONCE=false - Standard flow without explicit nonce or metadata',
    });

    // Set of env variables that specify how to set if a user is an admin
    // If not set, all users will be treated as regular users
    const _adminRole = process.env.OPENID_ADMIN_ROLE;
    const _adminRoleParameterPath = process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
    const _adminRoleTokenKind = process.env.OPENID_ADMIN_ROLE_TOKEN_KIND;

    const openidLogin = new CustomOpenIDStrategy(
      {
        config: openidConfig,
        scope: process.env.SOLID_OPENID_SCOPE,
        callbackURL: process.env.DOMAIN_SERVER + process.env.SOLID_OPENID_CALLBACK_URL,
        clockTolerance: process.env.OPENID_CLOCK_TOLERANCE || 300,
        usePKCE,
      },
      /**
       * @param {import('openid-client').TokenEndpointResponseHelpers} tokenset
       * @param {import('passport-jwt').VerifyCallback} done
       */
      async (tokenset, done) => {
        try {
          const userObj = await verifySolidUser(tokenset, openidConfig);
          done(null, userObj);
        } catch (err) {
          logger.error('[SolidOpenidStrategy] login failed', err);
          if (err.code === 'AUTH_FAILED' || err.code === 'EMAIL_DOMAIN_NOT_ALLOWED') {
            return done(null, false, { message: err.message });
          }
          done(err);
        }
      },
    );
    passport.use('openid', openidLogin);
    return openidConfig;
  } catch (err) {
    logger.error('[SolidOpenidStrategy]', err);
    return null;
  }
}

/**
 * Set OpenID config from a provider (e.g. first entry in SOLID_OPENID_PROVIDERS).
 * Used when only dynamic providers are configured so getSolidOpenIdConfig() and solidJwt work.
 * @param {{ issuer: string, clientId: string, clientSecret?: string }} provider
 * @returns {Promise<Configuration | null>}
 */
async function setupSolidOpenIdFromProvider(provider) {
  try {
    const clientMetadata = {
      client_id: provider.clientId,
      client_secret: provider.clientSecret || undefined,
    };
    openidConfig = await client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      clientMetadata,
      undefined,
      {
        [client.customFetch]: customFetch,
        execute: [client.allowInsecureRequests],
      },
    );
    logger.info('[SolidOpenidStrategy] OpenID config set from provider (for JWT/refresh)', {
      issuer: provider.issuer,
    });
    return openidConfig;
  } catch (err) {
    logger.error('[SolidOpenidStrategy] setupSolidOpenIdFromProvider failed', err);
    return null;
  }
}

/**
 * @function getOpenIdConfig
 * @description Returns the OpenID client instance.
 * @throws {Error} If the OpenID client is not initialized.
 * @returns {Configuration}
 */
function getSolidOpenIdConfig() {
  if (!openidConfig) {
    throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
  }
  return openidConfig;
}

module.exports = {
  setupSolidOpenIdFromProvider,
  getSolidOpenIdConfig,
  verifySolidUser,
};
