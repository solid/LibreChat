const { setupOpenId, getOpenIdConfig, getOpenIdEmail } = require('./openidStrategy');
const {
  setupSolidOpenIdFromProvider,
  getSolidOpenIdConfig,
  verifySolidUser,
} = require('./SolidOpenidStrategy');
const openIdJwtLogin = require('./openIdJwtStrategy');
const facebookLogin = require('./facebookStrategy');
const discordLogin = require('./discordStrategy');
const passportLogin = require('./localStrategy');
const googleLogin = require('./googleStrategy');
const githubLogin = require('./githubStrategy');
const { setupSaml } = require('./samlStrategy');
const appleLogin = require('./appleStrategy');
const ldapLogin = require('./ldapStrategy');
const jwtLogin = require('./jwtStrategy');

module.exports = {
  appleLogin,
  passportLogin,
  googleLogin,
  githubLogin,
  discordLogin,
  jwtLogin,
  facebookLogin,
  getOpenIdEmail,
  setupSolidOpenIdFromProvider,
  getSolidOpenIdConfig,
  verifySolidUser,
  setupOpenId,
  getOpenIdConfig,
  ldapLogin,
  setupSaml,
  openIdJwtLogin,
};
