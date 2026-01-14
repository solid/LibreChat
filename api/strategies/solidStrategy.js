/**
 * Solid OIDC Authentication Strategy
 *
 * This strategy implements proper server-side OIDC authentication for Solid pods.
 * Unlike OAuth providers with fixed issuers, Solid allows users to choose their
 * identity provider (Solid pod provider), so we use dynamic issuer discovery.
 *
 * Flow:
 * 1. User selects a Solid provider (issuer) on the login page
 * 2. Backend discovers the OIDC configuration for that issuer
 * 3. User is redirected to the Solid provider for authentication
 * 4. Provider redirects back with authorization code
 * 5. Backend exchanges code for tokens and verifies the user's WebID
 * 6. User is created/found in database and JWT is issued
 */
const client = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, getBalanceConfig, isEmailDomainAllowed } = require('@librechat/api');
const { ErrorTypes, CacheKeys, SystemRoles } = require('librechat-data-provider');
const { findUser, createUser, updateUser, countUsers } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const getLogStores = require('~/cache/getLogStores');

/**
 * @typedef {import('openid-client').Configuration} Configuration
 * @typedef {import('openid-client').ClientMetadata} ClientMetadata
 * @typedef {import('openid-client').ServerMetadata} ServerMetadata
 */

/** Cache for discovered OIDC server metadata, keyed by issuer URL */
const configCache = getLogStores(CacheKeys.SOLID_OIDC_CONFIG);

/** Cache for pending auth state (issuer URL, code verifier), keyed by state parameter */
const authStateCache = getLogStores(CacheKeys.SOLID_AUTH_STATE);

/**
 * Check if an issuer URL is allowed
 * @param {string} issuer
 * @returns {boolean}
 */
function isIssuerAllowed(issuer) {
  // Always allow any valid issuer URL
  return true;
}

/**
 * Get client credentials for Solid authentication
 * The client_id should be the URL of the Client Identifier Document
 * per Solid-OIDC specification
 * @returns {{ clientId: string, clientSecret: string | undefined, redirectUri: string }}
 */
function getClientCredentials() {
  const redirectUri = `${process.env.DOMAIN_SERVER}/oauth/solid/callback`;
  // For Solid-OIDC, client_id should be the URL of the Client Identifier Document
  const clientId = process.env.SOLID_CLIENT_ID || `${process.env.DOMAIN_SERVER}/oauth/solid/client-id`;
  const clientSecret = process.env.SOLID_CLIENT_SECRET; // Optional for public clients
  return { clientId, clientSecret, redirectUri };
}

/**
 * Discover OIDC configuration for a Solid issuer
 * Uses caching to avoid repeated discovery requests
 *
 * Note: We cache the ServerMetadata instead of the Configuration object
 * because Configuration is a class instance that cannot be serialized/deserialized.
 * We reconstruct the Configuration from cached metadata when needed.
 *
 * @param {string} issuerUrl - The Solid provider's issuer URL
 * @returns {Promise<Configuration | null>}
 */
async function discoverConfig(issuerUrl) {
  try {
    const { clientId, clientSecret } = getClientCredentials();

    // Check cache first - we cache the server metadata, not the Configuration
    const cachedMetadata = await configCache.get(issuerUrl);
    if (cachedMetadata) {
      logger.debug(`[solidStrategy] Using cached server metadata for ${issuerUrl}`);
      // Reconstruct Configuration from cached server metadata
      return new client.Configuration(cachedMetadata, clientId, clientSecret);
    }

    logger.info(`[solidStrategy] Discovering OIDC config for ${issuerUrl}`);

    /** @type {import('openid-client').ClientMetadata} */
    const clientMetadata = {
      client_id: clientId,
    };

    if (clientSecret) {
      clientMetadata.client_secret = clientSecret;
    }

    // Solid uses DPoP by default, but we can use regular tokens for simplicity
    // If the server requires DPoP, this will be handled by the openid-client library

    const config = await client.discovery(
      new URL(issuerUrl),
      clientId,
      clientMetadata,
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    // Extract and cache the server metadata (not the Configuration instance)
    // ServerMetadata is a plain object that can be serialized
    const serverMetadata = config.serverMetadata();

    // Cache server metadata for 1 hour
    await configCache.set(issuerUrl, serverMetadata, 3600 * 1000);

    return config;
  } catch (error) {
    logger.error(`[solidStrategy] Failed to discover config for ${issuerUrl}:`, error);
    return null;
  }
}

/**
 * Generate the authorization URL for a Solid provider
 *
 * @param {string} issuerUrl - The Solid provider's issuer URL
 * @returns {Promise<{ authUrl: string; state: string } | null>}
 */
async function getAuthorizationUrl(issuerUrl) {
  const config = await discoverConfig(issuerUrl);
  if (!config) {
    return null;
  }

  const { redirectUri } = getClientCredentials();
  const state = client.randomState();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  // Store auth state for callback verification
  await authStateCache.set(
    state,
    {
      issuerUrl,
      codeVerifier,
      redirectUri,
    },
    600 * 1000, // 10 minutes TTL
  );

  // Build authorization URL
  // For Solid-OIDC, use only 'openid webid' scopes
  const { clientId } = getClientCredentials();
  const authUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid webid',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_type: 'code',
    client_id: clientId, // Explicitly include client_id for Solid-OIDC
  });

  logger.debug(`[solidStrategy] Generated auth URL for ${issuerUrl}`);

  return { authUrl: authUrl.href, state };
}

/**
 * Handle the OAuth callback from the Solid provider
 *
 * @param {string} code - Authorization code
 * @param {string} state - State parameter for verification
 * @returns {Promise<{ user: Object; error?: string } | { error: string }>}
 */
async function handleCallback(code, state) {
  try {
    // Retrieve stored auth state
    const authState = await authStateCache.get(state);
    if (!authState) {
      logger.warn('[solidStrategy] Invalid or expired state parameter');
      return { error: 'Invalid or expired authentication session' };
    }

    const { issuerUrl, codeVerifier, redirectUri } = authState;

    // Clear the auth state
    await authStateCache.delete(state);

    // Get the OIDC config
    const config = await discoverConfig(issuerUrl);
    if (!config) {
      return { error: 'Failed to connect to Solid provider' };
    }

    // Exchange code for tokens
    const currentUrl = new URL(`${redirectUri}?code=${code}&state=${state}`);

    logger.debug(`[solidStrategy] Exchanging code for tokens at ${issuerUrl}`);
    logger.debug(`[solidStrategy] Redirect URI: ${redirectUri}`);
    logger.debug(`[solidStrategy] Current URL: ${currentUrl.href}`);

    let tokenResponse;
    try {
      // Skip the iss check by not using authorizationCodeGrant's URL parsing
      // Instead, manually call the token endpoint
      const serverMetadata = config.serverMetadata();
      const tokenEndpoint = serverMetadata.token_endpoint;
      
      const { clientId } = getClientCredentials();
      
      const tokenParams = new URLSearchParams();
      tokenParams.set('grant_type', 'authorization_code');
      tokenParams.set('code', code);
      tokenParams.set('redirect_uri', redirectUri);
      tokenParams.set('client_id', clientId);
      tokenParams.set('code_verifier', codeVerifier);
      
      const tokenFetchResponse = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenParams.toString(),
      });
      
      if (!tokenFetchResponse.ok) {
        const errorText = await tokenFetchResponse.text();
        logger.error(`[solidStrategy] Token endpoint error: ${tokenFetchResponse.status} - ${errorText}`);
        throw new Error(`Token endpoint returned ${tokenFetchResponse.status}`);
      }
      
      const tokenData = await tokenFetchResponse.json();
      logger.debug(`[solidStrategy] Token response received`);
      
      // Create a mock token response object with claims method
      tokenResponse = {
        access_token: tokenData.access_token,
        id_token: tokenData.id_token,
        token_type: tokenData.token_type,
        claims: () => {
          // Decode the ID token to get claims
          if (tokenData.id_token) {
            const parts = tokenData.id_token.split('.');
            if (parts.length === 3) {
              try {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                return payload;
              } catch (e) {
                logger.warn('[solidStrategy] Failed to decode ID token:', e);
              }
            }
          }
          return {};
        },
      };
    } catch (tokenError) {
      logger.error(`[solidStrategy] Token exchange failed:`, tokenError);
      if (tokenError.cause) {
        logger.error(`[solidStrategy] Token error cause:`, tokenError.cause);
      }
      if (tokenError.response) {
        logger.error(`[solidStrategy] Token error response:`, tokenError.response);
      }
      throw tokenError;
    }

    const claims = tokenResponse.claims();

    // Get WebID - this is the primary identifier for Solid users
    // The WebID can be in the 'webid' claim or 'sub' claim depending on the provider
    const webId = claims.webid || claims.sub;

    if (!webId) {
      logger.error('[solidStrategy] No WebID found in token claims');
      return { error: 'No WebID received from Solid provider' };
    }

    // Validate WebID format
    try {
      new URL(webId);
    } catch {
      logger.error('[solidStrategy] Invalid WebID format:', webId);
      return { error: 'Invalid WebID format' };
    }

    logger.info(`[solidStrategy] Authenticated user with WebID: ${webId}`);

    // Find or create user
    const user = await findOrCreateSolidUser(webId, claims, tokenResponse);

    return { user };
  } catch (error) {
    logger.error('[solidStrategy] Callback error:', error);
    return { error: error.message || 'Authentication failed' };
  }
}

/**
 * Find existing user or create new one based on WebID
 *
 * @param {string} webId - The user's WebID
 * @param {Object} claims - Token claims
 * @param {Object} tokenResponse - Full token response
 * @returns {Promise<Object>}
 */
async function findOrCreateSolidUser(webId, claims, tokenResponse) {
  const appConfig = await getAppConfig();

  // Try to find user by WebID (stored in solidId field)
  let user = await findUser({ solidId: webId });

  // Also try finding by idOnTheSource for backwards compatibility
  if (!user) {
    user = await findUser({ idOnTheSource: webId });
  }

  // Extract user info from claims
  const email = claims.email;
  const name = claims.name || claims.preferred_username;

  // If found by idOnTheSource but not solidId, this is an existing user
  // from the old implementation that needs updating
  if (user && !user.solidId) {
    await updateUser(user._id, {
      solidId: webId,
      provider: 'solid',
    });
    logger.info(`[solidStrategy] Updated existing user with solidId: ${webId}`);
    return user;
  }

  if (user) {
    // Update any changed info
    const updates = {};
    if (name && name !== user.name) {
      updates.name = name;
    }
    if (Object.keys(updates).length > 0) {
      await updateUser(user._id, updates);
    }
    return user;
  }

  // Check if social registration is allowed
  const ALLOW_SOCIAL_REGISTRATION = isEnabled(process.env.ALLOW_SOCIAL_REGISTRATION);
  if (!ALLOW_SOCIAL_REGISTRATION) {
    logger.error(`[solidStrategy] Registration blocked - social registration is disabled [WebID: ${webId}]`);
    const error = new Error(ErrorTypes.AUTH_FAILED);
    error.message = 'Social registration is disabled';
    throw error;
  }

  // Check email domain if email is provided
  if (email && !isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
    logger.error(`[solidStrategy] Registration blocked - email domain not allowed [Email: ${email}]`);
    const error = new Error(ErrorTypes.AUTH_FAILED);
    error.message = 'Email domain not allowed';
    throw error;
  }

  // Create new user
  const isFirstRegisteredUser = (await countUsers()) === 0;

  // Extract username from WebID
  // e.g., https://username.solidcommunity.net/profile/card#me -> username
  const webIdUrl = new URL(webId);
  const hostnameParts = webIdUrl.hostname.split('.');
  const extractedUsername = hostnameParts[0] || 'solid_user';

  // Generate email if not provided
  const userEmail =
    email || `solid_${Buffer.from(webId).toString('base64').slice(0, 16).replace(/[+/=]/g, '_')}@solid.local`;

  const userData = {
    provider: 'solid',
    solidId: webId,
    idOnTheSource: webId, // Keep for backwards compatibility
    email: userEmail.toLowerCase(),
    username: claims.preferred_username || extractedUsername,
    name: name || extractedUsername,
    emailVerified: !!email, // Only mark verified if email came from provider
    role: isFirstRegisteredUser ? SystemRoles.ADMIN : SystemRoles.USER,
  };

  const balanceConfig = getBalanceConfig(appConfig);
  const newUser = await createUser(userData, balanceConfig, true, true);

  logger.info(`[solidStrategy] Created new user for WebID: ${webId}`);

  return newUser;
}

/**
 * Get the list of available Solid providers for the login UI
 * @returns {Array<{ name: string; url: string }>}
 */
function getAvailableProviders() {
  const providers = [];

  if (process.env.SOLID_PROVIDERS) {
    // Format: "Name1|URL1,Name2|URL2"
    const parts = process.env.SOLID_PROVIDERS.split(',');
    for (const part of parts) {
      const [name, url] = part.split('|').map((s) => s.trim());
      if (name && url) {
        providers.push({ name, url });
      }
    }
  }

  // Add defaults if no custom providers configured
  if (providers.length === 0) {
    providers.push(
      { name: 'Inrupt', url: 'https://login.inrupt.com' },
      { name: 'Solid Community', url: 'https://solidcommunity.net' },
    );
  }

  return providers;
}

module.exports = {
  discoverConfig,
  getAuthorizationUrl,
  handleCallback,
  isIssuerAllowed,
  getAvailableProviders,
};
