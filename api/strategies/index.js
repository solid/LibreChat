const { setupOpenId, getOpenIdConfig, getOpenIdEmail } = require('./openidStrategy');
const { setupSolidOpenId, getSolidOpenIdConfig } = require('./SolidOpenidStrategy');
const openIdJwtLogin = require('./openIdJwtStrategy');
const facebookLogin = require('./facebookStrategy');
const discordLogin = require('./discordStrategy');
const passportLogin = require('./localStrategy');
const googleLogin = require('./googleStrategy');
const githubLogin = require('./githubStrategy');
const discordLogin = require('./discordStrategy');
const facebookLogin = require('./facebookStrategy');
const jwtLogin = require('./jwtStrategy');
const ldapLogin = require('./ldapStrategy');
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
  setupOpenId,
  getOpenIdConfig,
  getOpenIdEmail,
  setupSolidOpenId,
  getSolidOpenIdConfig,
  ldapLogin,
  setupSaml,
  openIdJwtLogin,
};
