const { logger } = require('@librechat/data-schemas');
const { createTempChatExpirationDate } = require('@librechat/api');
const { getMessages, deleteMessages } = require('./Message');
const { Conversation } = require('~/db/models');
const { isSolidUser } = require('~/server/utils/isSolidUser');
const {
  getConvoFromSolid,
  saveConvoToSolid,
  getConvosByCursorFromSolid,
  deleteConvosFromSolid,
} = require('~/server/services/SolidStorage');

/**
 * Searches for a conversation by conversationId and returns a lean document with only conversationId and user.
 * @param {string} conversationId - The conversation's ID.
 * @param {Object} [req] - Optional request object for Solid storage support.
 * @returns {Promise<{conversationId: string, user: string} | null>} The conversation object with selected fields or null if not found.
 */
const searchConversation = async (conversationId, req = null) => {
  try {
    // Solid users: use Solid storage only; no MongoDB fallback
    if (isSolidUser(req)) {
      const convo = await getConvoFromSolid(req, conversationId);
      if (convo) {
        return {
          conversationId: convo.conversationId,
          user: convo.user,
        };
      }
      return null;
    }

    return await Conversation.findOne({ conversationId }, 'conversationId user').lean();
  } catch (error) {
    logger.error('[searchConversation] Error searching conversation', error);
    throw new Error('Error searching conversation');
  }
};

/**
 * Retrieves a single conversation for a given user and conversation ID.
 * @param {string} user - The user's ID.
 * @param {string} conversationId - The conversation's ID.
 * @param {Object} [req] - Optional request object for Solid storage support.
 * @returns {Promise<TConversation>} The conversation object.
 */
const getConvo = async (user, conversationId, req = null) => {
  // Solid users: use Solid storage only; no MongoDB fallback
  if (isSolidUser(req)) {
    const convo = await getConvoFromSolid(req, conversationId);
    return convo ?? null;
  }

  try {
    return await Conversation.findOne({ user, conversationId }).lean();
  } catch (error) {
    logger.error('[getConvo] Error getting single conversation', error);
    throw new Error('Error getting single conversation');
  }
};

const deleteNullOrEmptyConversations = async () => {
  try {
    const filter = {
      $or: [
        { conversationId: null },
        { conversationId: '' },
        { conversationId: { $exists: false } },
      ],
    };

    const result = await Conversation.deleteMany(filter);

    // Delete associated messages
    const messageDeleteResult = await deleteMessages(filter);

    logger.info(
      `[deleteNullOrEmptyConversations] Deleted ${result.deletedCount} conversations and ${messageDeleteResult.deletedCount} messages`,
    );

    return {
      conversations: result,
      messages: messageDeleteResult,
    };
  } catch (error) {
    logger.error('[deleteNullOrEmptyConversations] Error deleting conversations', error);
    throw new Error('Error deleting conversations with null or empty conversationId');
  }
};

/**
 * Searches for a conversation by conversationId and returns associated file ids.
 * @param {string} conversationId - The conversation's ID.
 * @returns {Promise<string[] | null>}
 */
const getConvoFiles = async (conversationId) => {
  try {
    return (await Conversation.findOne({ conversationId }, 'files').lean())?.files ?? [];
  } catch (error) {
    logger.error('[getConvoFiles] Error getting conversation files', error);
    throw new Error('Error getting conversation files');
  }
};

module.exports = {
  getConvoFiles,
  searchConversation,
  deleteNullOrEmptyConversations,
  /**
   * Saves a conversation to the database.
   * @param {Object} req - The request object.
   * @param {string} conversationId - The conversation's ID.
   * @param {Object} metadata - Additional metadata to log for operation.
   * @returns {Promise<TConversation>} The conversation object.
   */
  saveConvo: async (req, { conversationId, newConversationId, ...convo }, metadata) => {
    if (metadata?.context) {
      logger.debug(`[saveConvo] ${metadata.context}`);
    }

    // Build shared payload: expiredAt and base convo fields
    let expiredAt = null;
    if (req?.body?.isTemporary) {
      try {
        const appConfig = req.config;
        expiredAt = createTempChatExpirationDate(appConfig?.interfaceConfig);
      } catch (err) {
        logger.error('Error creating temporary chat expiration date:', err);
        logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
      }
    }
    const baseConvo = {
      conversationId,
      newConversationId,
      ...convo,
      expiredAt,
    };

    if (isSolidUser(req)) {
      try {
        // Full document aligned with schema (same shape as MongoDB); SolidStorage adds messages + timestamps
        const finalConversationId = newConversationId || conversationId;
        const convoDocument = {
          ...baseConvo,
          conversationId: finalConversationId,
          user: req.user.id,
        };
        if (newConversationId && newConversationId !== conversationId) {
          convoDocument.previousConversationId = conversationId;
        }
        const savedConvo = await saveConvoToSolid(req, convoDocument, metadata);
        return savedConvo;
      } catch (error) {
        logger.error('[saveConvo] Error saving conversation to Solid Pod', error);
        if (metadata && metadata?.context) {
          logger.info(`[saveConvo] ${metadata.context}`);
        }
        throw error;
      }
    }

    try {
      const messages = await getMessages({ conversationId }, '_id');
      const update = { ...convo, messages, user: req.user.id, expiredAt };
      if (newConversationId) {
        update.conversationId = newConversationId;
      }

      /** @type {{ $set: Partial<TConversation>; $unset?: Record<keyof TConversation, number> }} */
      const updateOperation = { $set: update };
      if (metadata && metadata.unsetFields && Object.keys(metadata.unsetFields).length > 0) {
        updateOperation.$unset = metadata.unsetFields;
      }

      /** Note: the resulting Model object is necessary for Meilisearch operations */
      const conversation = await Conversation.findOneAndUpdate(
        { conversationId, user: req.user.id },
        updateOperation,
        { new: true, upsert: metadata?.noUpsert !== true },
      );

      if (!conversation) {
        logger.debug('[saveConvo] Conversation not found, skipping update');
        return null;
      }

      return conversation.toObject();
    } catch (error) {
      logger.error('[saveConvo] Error saving conversation', error);
      if (metadata && metadata?.context) {
        logger.info(`[saveConvo] ${metadata.context}`);
      }
      return { message: 'Error saving conversation' };
    }
  },
  bulkSaveConvos: async (conversations) => {
    try {
      const bulkOps = conversations.map((convo) => ({
        updateOne: {
          filter: { conversationId: convo.conversationId, user: convo.user },
          update: convo,
          upsert: true,
          timestamps: false,
        },
      }));

      const result = await Conversation.bulkWrite(bulkOps);
      return result;
    } catch (error) {
      logger.error('[bulkSaveConvos] Error saving conversations in bulk', error);
      throw new Error('Failed to save conversations in bulk.');
    }
  },
  getConvosByCursor: async (
    user,
    {
      cursor,
      limit = 25,
      isArchived = false,
      tags,
      search,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
      req, // Optional req object for Solid storage
    } = {},
  ) => {
    if (isSolidUser(req)) {
      return await getConvosByCursorFromSolid(req, {
        cursor,
        limit,
        isArchived,
        tags,
        search,
        sortBy,
        sortDirection,
      });
    }
    const filters = [{ user }];
    if (isArchived) {
      filters.push({ isArchived: true });
    } else {
      filters.push({ $or: [{ isArchived: false }, { isArchived: { $exists: false } }] });
    }

    if (Array.isArray(tags) && tags.length > 0) {
      filters.push({ tags: { $in: tags } });
    }

    filters.push({ $or: [{ expiredAt: null }, { expiredAt: { $exists: false } }] });

    if (search) {
      try {
        const meiliResults = await Conversation.meiliSearch(search, { filter: `user = "${user}"` });
        const matchingIds = Array.isArray(meiliResults.hits)
          ? meiliResults.hits.map((result) => result.conversationId)
          : [];
        if (!matchingIds.length) {
          return { conversations: [], nextCursor: null };
        }
        filters.push({ conversationId: { $in: matchingIds } });
      } catch (error) {
        logger.error('[getConvosByCursor] Error during meiliSearch', error);
        throw new Error('Error during meiliSearch');
      }
    }

    const validSortFields = ['title', 'createdAt', 'updatedAt'];
    if (!validSortFields.includes(sortBy)) {
      throw new Error(
        `Invalid sortBy field: ${sortBy}. Must be one of ${validSortFields.join(', ')}`,
      );
    }
    const finalSortBy = sortBy;
    const finalSortDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    let cursorFilter = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        const { primary, secondary } = decoded;
        const primaryValue = finalSortBy === 'title' ? primary : new Date(primary);
        const secondaryValue = new Date(secondary);
        const op = finalSortDirection === 'asc' ? '$gt' : '$lt';

        cursorFilter = {
          $or: [
            { [finalSortBy]: { [op]: primaryValue } },
            {
              [finalSortBy]: primaryValue,
              updatedAt: { [op]: secondaryValue },
            },
          ],
        };
      } catch (_err) {
        logger.warn('[getConvosByCursor] Invalid cursor format, starting from beginning');
      }
      if (cursorFilter) {
        filters.push(cursorFilter);
      }
    }

    const query = filters.length === 1 ? filters[0] : { $and: filters };

    try {
      const sortOrder = finalSortDirection === 'asc' ? 1 : -1;
      const sortObj = { [finalSortBy]: sortOrder };

      if (finalSortBy !== 'updatedAt') {
        sortObj.updatedAt = sortOrder;
      }

      const convos = await Conversation.find(query)
        .select(
          'conversationId endpoint title createdAt updatedAt user model agent_id assistant_id spec iconURL',
        )
        .sort(sortObj)
        .limit(limit + 1)
        .lean();

      let nextCursor = null;
      if (convos.length > limit) {
        convos.pop(); // Remove extra item used to detect next page
        // Create cursor from the last RETURNED item (not the popped one)
        const lastReturned = convos[convos.length - 1];
        const primaryValue = lastReturned[finalSortBy];
        const primaryStr = finalSortBy === 'title' ? primaryValue : primaryValue.toISOString();
        const secondaryStr = lastReturned.updatedAt.toISOString();
        const composite = { primary: primaryStr, secondary: secondaryStr };
        nextCursor = Buffer.from(JSON.stringify(composite)).toString('base64');
      }

      return { conversations: convos, nextCursor };
    } catch (error) {
      logger.error('[getConvosByCursor] Error getting conversations', error);
      throw new Error('Error getting conversations');
    }
  },
  getConvosQueried: async (user, convoIds, cursor = null, limit = 25) => {
    try {
      if (!convoIds?.length) {
        return { conversations: [], nextCursor: null, convoMap: {} };
      }

      const conversationIds = convoIds.map((convo) => convo.conversationId);

      const results = await Conversation.find({
        user,
        conversationId: { $in: conversationIds },
        $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
      }).lean();

      results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      let filtered = results;
      if (cursor && cursor !== 'start') {
        const cursorDate = new Date(cursor);
        filtered = results.filter((convo) => new Date(convo.updatedAt) < cursorDate);
      }

      const limited = filtered.slice(0, limit + 1);
      let nextCursor = null;
      if (limited.length > limit) {
        limited.pop(); // Remove extra item used to detect next page
        // Create cursor from the last RETURNED item (not the popped one)
        nextCursor = limited[limited.length - 1].updatedAt.toISOString();
      }

      const convoMap = {};
      limited.forEach((convo) => {
        convoMap[convo.conversationId] = convo;
      });

      return { conversations: limited, nextCursor, convoMap };
    } catch (error) {
      logger.error('[getConvosQueried] Error getting conversations', error);
      throw new Error('Error fetching conversations');
    }
  },
  getConvo,
  /* chore: this method is not properly error handled */
  getConvoTitle: async (user, conversationId) => {
    try {
      const convo = await getConvo(user, conversationId);
      /* ChatGPT Browser was triggering error here due to convo being saved later */
      if (convo && !convo.title) {
        return null;
      } else {
        // TypeError: Cannot read properties of null (reading 'title')
        return convo?.title || 'New Chat';
      }
    } catch (error) {
      logger.error('[getConvoTitle] Error getting conversation title', error);
      throw new Error('Error getting conversation title');
    }
  },
  /**
   * Asynchronously deletes conversations and associated messages for a given user and filter.
   *
   * @async
   * @function
   * @param {string|ObjectId} user - The user's ID.
   * @param {Object} filter - Additional filter criteria for the conversations to be deleted.
   * @param {Object} [req] - Optional Express request object for Solid storage support.
   * @returns {Promise<{ n: number, ok: number, deletedCount: number, messages: { n: number, ok: number, deletedCount: number } }>}
   *          An object containing the count of deleted conversations and associated messages.
   * @throws {Error} Throws an error if there's an issue with the database operations.
   *
   * @example
   * const user = 'someUserId';
   * const filter = { someField: 'someValue' };
   * const result = await deleteConvos(user, filter);
   * logger.error(result); // { n: 5, ok: 1, deletedCount: 5, messages: { n: 10, ok: 1, deletedCount: 10 } }
   */
  deleteConvos: async (user, filter, req = null) => {
    // Use Solid storage when user logged in via "Continue with Solid"
    if (isSolidUser(req)) {
      try {
        let conversationIds = [];

        // If conversationId is specified in filter, use it directly
        if (filter.conversationId) {
          conversationIds = [filter.conversationId];
        } else {
          // Otherwise, get all conversations matching the filter from Solid Pod
          // For now, we'll get all conversations and filter in memory
          // This is not ideal for large datasets, but Solid Pod doesn't support complex queries
          const allConversations = await getConvosByCursorFromSolid(req, {
            limit: 10000, // Large limit to get all conversations
            isArchived: filter.isArchived,
          });

          // Filter conversations based on the filter criteria
          let filteredConversations = allConversations.conversations;

          if (filter.conversationId) {
            filteredConversations = filteredConversations.filter(
              (c) => c.conversationId === filter.conversationId,
            );
          }

          if (filter.endpoint) {
            filteredConversations = filteredConversations.filter(
              (c) => c.endpoint === filter.endpoint,
            );
          }

          conversationIds = filteredConversations.map((c) => c.conversationId);
        }

        if (!conversationIds.length) {
          throw new Error('Conversation not found or already deleted.');
        }

        const deletedCount = await deleteConvosFromSolid(req, conversationIds);

        // Return format similar to MongoDB deleteMany result
        return {
          n: deletedCount,
          ok: deletedCount > 0 ? 1 : 0,
          deletedCount,
          messages: {
            n: deletedCount, // Messages are deleted as part of deleteConvosFromSolid
            ok: deletedCount > 0 ? 1 : 0,
            deletedCount,
          },
        };
      } catch (error) {
        logger.error('[deleteConvos] Error deleting conversations from Solid Pod', {
          error: error.message,
          stack: error.stack,
          filter,
          userId: user,
        });
        throw error;
      }
    }

    // MongoDB storage (original code)
    try {
      const userFilter = { ...filter, user };
      const conversations = await Conversation.find(userFilter).select('conversationId');
      const conversationIds = conversations.map((c) => c.conversationId);

      if (!conversationIds.length) {
        throw new Error('Conversation not found or already deleted.');
      }

      const deleteConvoResult = await Conversation.deleteMany(userFilter);

      const deleteMessagesResult = await deleteMessages({
        conversationId: { $in: conversationIds },
      });

      return { ...deleteConvoResult, messages: deleteMessagesResult };
    } catch (error) {
      logger.error('[deleteConvos] Error deleting conversations and messages', error);
      throw error;
    }
  },
};
