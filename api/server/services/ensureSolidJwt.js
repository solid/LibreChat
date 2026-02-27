/**
 * Ensures the solidJwt Passport strategy is registered when Solid is enabled.
 * Used at startup (socialLogins) and on first request (lazy) if IdP was down at startup.
 * @returns {Promise<boolean>} true if solidJwt is now registered (or was already), false otherwise
 */
const passport = require('passport');
const { getSolidOpenIdProvidersForJwt } = require('./Config/solidOpenId');
const { setupSolidOpenIdFromProvider, openIdJwtLogin } = require('~/strategies');
const { logger } = require('@librechat/data-schemas');

let lazyInitPromise = null;

async function ensureSolidJwtRegistered() {
  if (passport._strategies && passport._strategies.solidJwt) {
    return true;
  }
  const providers = getSolidOpenIdProvidersForJwt();
  if (providers.length === 0) {
    return false;
  }
  const config = await setupSolidOpenIdFromProvider(providers[0]);
  if (!config) {
    logger.warn('[ensureSolidJwt] Discovery for first provider failed', {
      issuer: providers[0].issuer,
    });
    return false;
  }
  if (passport._strategies && passport._strategies.solidJwt) {
    return true;
  }
  passport.use('solidJwt', openIdJwtLogin(config));
  logger.info('[ensureSolidJwt] solidJwt registered from first provider (lazy or startup).');
  return true;
}

/**
 * Call once from auth middleware when 503 would be returned for Solid; runs at most one discovery in flight.
 * @returns {Promise<boolean>}
 */
async function ensureSolidJwtRegisteredLazy() {
  if (passport._strategies && passport._strategies.solidJwt) {
    return true;
  }
  if (!lazyInitPromise) {
    lazyInitPromise = ensureSolidJwtRegistered().finally(() => {
      lazyInitPromise = null;
    });
  }
  return lazyInitPromise;
}

module.exports = {
  ensureSolidJwtRegistered,
  ensureSolidJwtRegisteredLazy,
};
