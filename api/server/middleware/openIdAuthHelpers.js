/**
 * Shared 503 response when OpenID/Solid JWT strategy is not registered.
 * Used by requireJwtAuth and optionalJwtAuth to avoid duplicating message logic.
 * @param {import('express').Response} res
 * @param {'solid' | 'openid'} tokenProvider
 * @param {boolean} [afterLazyInit] - True when lazy init was attempted for Solid and still not registered
 */
function sendStrategyNotRegistered503(res, tokenProvider, afterLazyInit = false) {
  const name = tokenProvider === 'solid' ? 'Solid' : 'OpenID';
  const message =
    afterLazyInit && tokenProvider === 'solid'
      ? 'You logged in with Solid, but the server could not register the Solid strategy. Ensure your Solid IdP (e.g. Local CSS) is running and SOLID_OPENID_PROVIDERS (or legacy Solid env) is set.'
      : `You logged in with ${name}, but the server does not have the corresponding strategy registered. Please contact the administrator.`;
  return res.status(503).json({
    error: 'Authentication not configured',
    message,
  });
}

module.exports = { sendStrategyNotRegistered503 };
