const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { setAuthTokens } = require('~/server/services/AuthService');
const { findUser, createUser, updateUser, countUsers } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

/**
 * Solid Authentication Controller
 * Handles authentication with Solid OIDC by WebID
 * Creates or finds user based on WebID and returns JWT token
 */
const solidAuthController = async (req, res) => {
  try {
    logger.info('[solidAuthController] Request received:', { method: req.method, url: req.url, body: req.body });
    const { webId } = req.body;

    if (!webId || typeof webId !== 'string') {
      logger.warn('[solidAuthController] Missing or invalid WebID');
      return res.status(400).json({ message: 'WebID is required' });
    }

    // Validate WebID format (should be a valid URL)
    try {
      new URL(webId);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid WebID format' });
    }

    // Extract email from WebID if possible (some providers include email in WebID)
    // For example: https://username.solidcommunity.net/profile/card#me
    // Or: https://pod.example.com/profile/card#me
    let email = null;
    try {
      // Try to extract a potential email from WebID
      // This is a fallback - most Solid providers don't expose email in WebID
      const webIdUrl = new URL(webId);
      // Some providers use email-like structure in domain
      const hostname = webIdUrl.hostname;
      if (hostname.includes('@')) {
        email = hostname;
      }
    } catch (err) {
      // Ignore email extraction errors
    }

    // Use WebID as the unique identifier (stored in idOnTheSource)
    // Find existing user by idOnTheSource or email
    let user = await findUser({ idOnTheSource: webId });

    if (!user && email) {
      user = await findUser({ email: email.toLowerCase() });
    }

    const appConfig = await getAppConfig();
    const isFirstRegisteredUser = (await countUsers()) === 0;

    if (!user) {
      // Create new user
      // Extract username from WebID (e.g., username from https://username.solidcommunity.net)
      const webIdUrl = new URL(webId);
      const hostnameParts = webIdUrl.hostname.split('.');
      const username = hostnameParts[0] || 'solid_user';
      
      // Generate a unique email if not available
      // Use WebID hash as email identifier
      const emailFromWebId = email || `solid_${Buffer.from(webId).toString('base64').slice(0, 16)}@solid.local`;

      const userData = {
        provider: 'solid',
        email: emailFromWebId.toLowerCase(),
        username: username,
        name: username, // Can be updated later from Solid profile
        emailVerified: true, // Solid OIDC already verified the identity
        idOnTheSource: webId,
        role: isFirstRegisteredUser ? SystemRoles.ADMIN : SystemRoles.USER,
      };

      const newUser = await createUser(userData, appConfig.balance, true, true);
      user = newUser;
      
      logger.info(`[solidAuthController] New Solid user created [WebID: ${webId}]`);
    } else {
      // Update existing user if needed
      if (!user.idOnTheSource) {
        await updateUser(user._id, {
          idOnTheSource: webId,
          provider: 'solid',
        });
        logger.info(`[solidAuthController] Updated user with WebID [WebID: ${webId}]`);
      }
    }

    // Generate JWT token and set cookies
    const { password: _p, totpSecret: _t, __v, ...userData } = user;
    userData.id = user._id.toString();

    const token = await setAuthTokens(user._id, res);

    logger.info('[solidAuthController] Authentication successful:', { userId: user._id, webId });
    return res.status(200).json({ token, user: userData });
  } catch (err) {
    logger.error('[solidAuthController] Error:', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = {
  solidAuthController,
};

