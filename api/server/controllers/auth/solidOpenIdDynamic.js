/**
 * Dynamic Solid OpenID flow: start and callback for multi-issuer (issuer in query / state).
 * When frontend sends ?issuer=..., we do discovery for that issuer, store PKCE in session,
 * redirect to IdP. On callback we read state (contains issuer), exchange code, verify user.
 */

const client = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { getSolidOpenIdProviderByIssuer } = require('~/server/services/Config/solidOpenId');
const { verifySolidUser } = require('~/strategies');
const undici = require('undici');

const SESSION_KEY = 'solidOpenIdPKCE';
const STATE_PREFIX = 'solid_';

/**
 * Encode state payload (issuer + random) for round-trip.
 * @param {{ issuer: string, rnd: string }} payload
 * @returns {string}
 */
function encodeState(payload) {
  return STATE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode state if it's our format (starts with solid_).
 * @param {string} state
 * @returns {{ issuer: string, rnd: string } | null}
 */
function decodeState(state) {
  if (!state || typeof state !== 'string' || !state.startsWith(STATE_PREFIX)) {
    return null;
  }
  try {
    const json = Buffer.from(state.slice(STATE_PREFIX.length), 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (payload && typeof payload.issuer === 'string') {
      return payload;
    }
  } catch (e) {
    logger.debug('[solidOpenIdDynamic] decodeState failed', { error: e?.message });
  }
  return null;
}

async function customFetchForDiscovery(url, options) {
  let fetchOptions = options;
  if (process.env.PROXY) {
    fetchOptions = { ...options, dispatcher: new undici.ProxyAgent(process.env.PROXY) };
  }
  return undici.fetch(url, fetchOptions);
}

const discoveryOptions = {
  [client.customFetch]: customFetchForDiscovery,
  execute: [client.allowInsecureRequests],
};

/**
 * Start Solid OpenID flow for the given issuer (from query). Validate issuer, do discovery,
 * store PKCE in session, redirect to IdP.
 */
async function startSolidOpenIdFlow(req, res, next) {
  const issuer = req.query.issuer;
  if (!issuer || typeof issuer !== 'string') {
    return next();
  }

  const provider = getSolidOpenIdProviderByIssuer(issuer.trim());
  if (!provider) {
    logger.warn('[solidOpenIdDynamic] Unknown or unconfigured issuer', {
      issuer: issuer.slice(0, 80),
    });
    res
      .status(400)
      .send(
        'Unknown or unconfigured Solid Identity Provider. Use one of the options from the login page.',
      );
    return;
  }

  try {
    const clientMetadata = {
      client_id: provider.clientId,
      client_secret: provider.clientSecret || undefined,
    };
    const clientAuth = provider.clientSecret
      ? client.ClientSecretPost(provider.clientSecret)
      : undefined;

    const config = await client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      clientMetadata,
      clientAuth,
      discoveryOptions,
    );

    const statePayload = {
      issuer: provider.issuer,
      rnd: client.randomState(),
    };
    const state = encodeState(statePayload);

    // Solid-OIDC requires PKCE for authorization code; always use it for this flow.
    const usePKCE = true;
    let code_verifier;
    const authParams = {
      redirect_uri: process.env.DOMAIN_SERVER + provider.callbackPath,
      scope: provider.scope,
      state,
      prompt: 'consent',
    };
    if (usePKCE) {
      code_verifier = client.randomPKCECodeVerifier();
      authParams.code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
      authParams.code_challenge_method = 'S256';
    }

    if (!req.session) {
      logger.error('[solidOpenIdDynamic] No session available for PKCE storage');
      res.status(500).send('Session required for Solid login.');
      return;
    }
    if (!req.session[SESSION_KEY]) {
      req.session[SESSION_KEY] = {};
    }
    req.session[SESSION_KEY][state] = { code_verifier, issuer: provider.issuer };
    req.session.save((err) => {
      if (err) {
        logger.error('[solidOpenIdDynamic] Session save failed', err);
        res.status(500).send('Session error.');
        return;
      }
      const redirectTo = client.buildAuthorizationUrl(config, authParams);
      logger.info('[solidOpenIdDynamic] Redirecting to Solid IdP', { issuer: provider.issuer });
      res.redirect(redirectTo.toString());
    });
  } catch (err) {
    logger.error('[solidOpenIdDynamic] startSolidOpenIdFlow failed', err);
    next(err);
  }
}

/**
 * Handle Solid OpenID callback when state is our format (multi-issuer flow).
 * Exchange code for tokens, verify user, set req.user and call next() to run oauthHandler.
 */
async function handleSolidOpenIdCallback(req, res, next) {
  const state = req.query.state;
  const decoded = decodeState(state);
  if (!decoded) {
    return next();
  }

  const code = req.query.code;
  if (!code) {
    const errParam = req.query.error;
    const errDesc = req.query.error_description;
    logger.warn(
      '[solidOpenIdDynamic] Callback missing code - IdP likely rejected the auth request',
      {
        error: errParam,
        error_description: errDesc,
      },
    );
    res.redirect(`${process.env.DOMAIN_CLIENT}/login?redirect=false&error=auth_failed`);
    return;
  }

  const sessionData = req.session && req.session[SESSION_KEY] && req.session[SESSION_KEY][state];
  if (!sessionData || !sessionData.code_verifier) {
    logger.warn('[solidOpenIdDynamic] No PKCE data in session for state');
    res.redirect(`${process.env.DOMAIN_CLIENT}/login?redirect=false&error=auth_failed`);
    return;
  }

  const provider = getSolidOpenIdProviderByIssuer(decoded.issuer);
  if (!provider) {
    logger.warn('[solidOpenIdDynamic] Callback issuer not configured', { issuer: decoded.issuer });
    res.redirect(`${process.env.DOMAIN_CLIENT}/login?redirect=false&error=auth_failed`);
    return;
  }

  try {
    const clientMetadata = {
      client_id: provider.clientId,
      client_secret: provider.clientSecret || undefined,
    };
    const clientAuth = provider.clientSecret
      ? client.ClientSecretPost(provider.clientSecret)
      : undefined;

    const config = await client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      clientMetadata,
      clientAuth,
      discoveryOptions,
    );

    const currentUrl = new URL(req.originalUrl || req.url, process.env.DOMAIN_SERVER);

    const tokenset = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: state,
      ...(sessionData.code_verifier && { pkceCodeVerifier: sessionData.code_verifier }),
    });

    delete req.session[SESSION_KEY][state];
    req.session.save(() => {});

    const user = await verifySolidUser(tokenset, config);
    req.user = user;
    next();
  } catch (err) {
    logger.error('[solidOpenIdDynamic] handleSolidOpenIdCallback failed', err);
    res.redirect(`${process.env.DOMAIN_CLIENT}/login?redirect=false&error=auth_failed`);
  }
}

module.exports = {
  startSolidOpenIdFlow,
  handleSolidOpenIdCallback,
};
