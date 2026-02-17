const { setupOpenId, getOpenIdConfig } = require('./openidStrategy');
const { setupSolidOpenId, getSolidOpenIdConfig } = require('./SolidOpenidStrategy');
const openIdJwtLogin = require('./openIdJwtStrategy');
const facebookLogin = require('./facebookStrategy');
const discordLogin = require('./discordStrategy');
const passportLogin = require('./localStrategy');
const googleLogin = require('./googleStrategy');
const githubLogin = require('./githubStrategy');
const jwtLogin = require('./jwtStrategy');
const ldapLogin = require('./ldapStrategy');
const { setupSaml } = require('./samlStrategy');
const appleLogin = require('./appleStrategy');

module.exports = {
  appleLogin,
  passportLogin,
  googleLogin,
  githubLogin,
  discordLogin,
  jwtLogin,
  facebookLogin,
  setupSolidOpenId,
  getSolidOpenIdConfig,
  setupOpenId,
  getOpenIdConfig,
  ldapLogin,
  setupSaml,
  openIdJwtLogin,
};
