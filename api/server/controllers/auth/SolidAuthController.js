/**
 * @deprecated This controller has been removed for security reasons.
 *
 * The previous implementation trusted WebID claims from the client without
 * server-side verification, allowing anyone to impersonate any Solid user.
 *
 * Solid authentication is now handled via proper OIDC flow at /oauth/solid
 * which performs server-side token verification before trusting the WebID.
 *
 * See: api/strategies/solidStrategy.js for the new implementation
 * See: api/server/routes/oauth.js for the /oauth/solid routes
 */

module.exports = {
  // No exports - this file is kept for documentation purposes only
};