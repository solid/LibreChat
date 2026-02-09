const { getConvo } = require('~/models');
const { getConvoFromSolid } = require('~/server/services/SolidStorage');
const { isSolidUser } = require('~/server/utils/isSolidUser');

// Middleware to validate conversationId and user relationship
const validateMessageReq = async (req, res, next) => {
  let conversationId = req.params.conversationId || req.body.conversationId;

  if (conversationId === 'new') {
    return res.status(200).send([]);
  }

  if (!conversationId && req.body.message) {
    conversationId = req.body.message.conversationId;
  }

  let conversation = null;

  // Use Solid storage when user logged in via "Continue with Solid"
  if (isSolidUser(req)) {
    try {
      conversation = await getConvoFromSolid(req, conversationId);
    } catch (error) {
      // If Solid storage fails, fall back to MongoDB
      // Don't log error here as it might be expected (conversation doesn't exist in Solid yet)
    }
  }

  // Fallback to MongoDB if Solid storage is disabled or didn't find the conversation
  if (!conversation) {
    conversation = await getConvo(req.user.id, conversationId);
  }

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  if (conversation.user !== req.user.id) {
    return res.status(403).json({ error: 'User not authorized for this conversation' });
  }

  next();
};

module.exports = validateMessageReq;
