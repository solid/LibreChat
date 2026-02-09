/**
 * Determines if the request belongs to a user who logged in via "Continue with Solid".
 * Only those users get Solid Pod storage; "Continue with OpenID" and others use MongoDB.
 *
 * @param {import('express').Request} [req] - Express request with optional user
 * @returns {boolean}
 */
function isSolidUser(req) {
  return !!(req && req.user?.provider === 'solid');
}

module.exports = { isSolidUser };
