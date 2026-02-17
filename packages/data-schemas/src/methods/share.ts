import { nanoid } from 'nanoid';
import { Constants } from 'librechat-data-provider';
import type { FilterQuery, Model } from 'mongoose';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type * as t from '~/types';
import logger from '~/config/winston';

// Solid storage and auth helpers – required at runtime when share methods run in api server context
const getSolidStorage = () => require('~/server/services/SolidStorage');
const getIsSolidUser = () => require('~/server/utils/isSolidUser').isSolidUser;

class ShareServiceError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ShareServiceError';
    this.code = code;
  }
}

function memoizedAnonymizeId(prefix: string) {
  const memo = new Map<string, string>();
  return (id: string) => {
    if (!memo.has(id)) {
      memo.set(id, `${prefix}_${nanoid()}`);
    }
    return memo.get(id) as string;
  };
}

const anonymizeConvoId = memoizedAnonymizeId('convo');
const anonymizeAssistantId = memoizedAnonymizeId('a');
const anonymizeMessageId = (id: string) =>
  id === Constants.NO_PARENT ? id : memoizedAnonymizeId('msg')(id);

function anonymizeConvo(conversation: Partial<t.IConversation> & Partial<t.ISharedLink>) {
  if (!conversation) {
    return null;
  }

  const newConvo = { ...conversation };
  if (newConvo.assistant_id) {
    newConvo.assistant_id = anonymizeAssistantId(newConvo.assistant_id);
  }
  return newConvo;
}

function anonymizeMessages(messages: t.IMessage[], newConvoId: string): t.IMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const idMap = new Map<string, string>();
  return messages.map((message) => {
    const newMessageId = anonymizeMessageId(message.messageId);
    idMap.set(message.messageId, newMessageId);

    type MessageAttachment = {
      messageId?: string;
      conversationId?: string;
      [key: string]: unknown;
    };

    const anonymizedAttachments = (message.attachments as MessageAttachment[])?.map(
      (attachment) => {
        return {
          ...attachment,
          messageId: newMessageId,
          conversationId: newConvoId,
        };
      },
    );

    return {
      ...message,
      messageId: newMessageId,
      parentMessageId:
        idMap.get(message.parentMessageId || '') ||
        anonymizeMessageId(message.parentMessageId || ''),
      conversationId: newConvoId,
      model: message.model?.startsWith('asst_')
        ? anonymizeAssistantId(message.model)
        : message.model,
      attachments: anonymizedAttachments,
    } as t.IMessage;
  });
}

/**
 * Filter messages up to and including the target message (branch-specific)
 * Similar to getMessagesUpToTargetLevel from fork utilities
 */
function getMessagesUpToTarget(messages: t.IMessage[], targetMessageId: string): t.IMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  // If only one message and it's the target, return it
  if (messages.length === 1 && messages[0]?.messageId === targetMessageId) {
    return messages;
  }

  // Create a map of parentMessageId to children messages
  const parentToChildrenMap = new Map<string, t.IMessage[]>();
  for (const message of messages) {
    const parentId = message.parentMessageId || Constants.NO_PARENT;
    if (!parentToChildrenMap.has(parentId)) {
      parentToChildrenMap.set(parentId, []);
    }
    parentToChildrenMap.get(parentId)?.push(message);
  }

  // Find the target message
  const targetMessage = messages.find((msg) => msg.messageId === targetMessageId);
  if (!targetMessage) {
    // If target not found, return all messages for backwards compatibility
    return messages;
  }

  const visited = new Set<string>();
  const rootMessages = parentToChildrenMap.get(Constants.NO_PARENT) || [];
  let currentLevel = rootMessages.length > 0 ? [...rootMessages] : [targetMessage];
  const results = new Set<t.IMessage>(currentLevel);

  // Check if the target message is at the root level
  if (
    currentLevel.some((msg) => msg.messageId === targetMessageId) &&
    targetMessage.parentMessageId === Constants.NO_PARENT
  ) {
    return Array.from(results);
  }

  // Iterate level by level until the target is found
  let targetFound = false;
  while (!targetFound && currentLevel.length > 0) {
    const nextLevel: t.IMessage[] = [];
    for (const node of currentLevel) {
      if (visited.has(node.messageId)) {
        continue;
      }
      visited.add(node.messageId);
      const children = parentToChildrenMap.get(node.messageId) || [];
      for (const child of children) {
        if (visited.has(child.messageId)) {
          continue;
        }
        nextLevel.push(child);
        results.add(child);
        if (child.messageId === targetMessageId) {
          targetFound = true;
        }
      }
    }
    currentLevel = nextLevel;
  }

  return Array.from(results);
}

/** Factory function that takes mongoose instance and returns the methods */
export function createShareMethods(mongoose: typeof import('mongoose')) {
  /**
   * Get shared messages for a public share link
   */
  async function getSharedMessages(shareId: string): Promise<t.SharedMessagesResult | null> {
    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const share = (await SharedLink.findOne({ shareId, isPublic: true })
        .select('-_id -__v -user')
        .lean()) as t.ISharedLink | null;

      if (!share?.conversationId || !share.isPublic) {
        return null;
      }

      // Check if this is a Solid share (has podUrl)
      if (share.podUrl) {
        // Get shared messages from Solid Pod
        try {
          const { getSharedMessagesFromSolid } = getSolidStorage();
          const solidShare = await getSharedMessagesFromSolid(
            shareId,
            share.conversationId,
            share.podUrl,
            share.targetMessageId,
          );

          if (!solidShare) {
            return null;
          }

          // Anonymize the conversation and messages
          const newConvoId = anonymizeConvoId(solidShare.conversationId);
          const result: t.SharedMessagesResult = {
            shareId: solidShare.shareId || shareId,
            title: solidShare.title,
            isPublic: solidShare.isPublic,
            createdAt: solidShare.createdAt,
            updatedAt: solidShare.updatedAt,
            conversationId: newConvoId,
            messages: anonymizeMessages(solidShare.messages, newConvoId),
          };

          return result;
        } catch (error) {
          logger.error('[getSharedMessages] Error getting shared messages from Solid Pod', {
            error: error instanceof Error ? error.message : 'Unknown error',
            shareId,
            conversationId: share.conversationId,
            podUrl: share.podUrl,
          });
          return null;
        }
      }

      // MongoDB share - use existing logic (separate query with populate to get messages)
      const shareWithMessages = (await SharedLink.findOne({ shareId, isPublic: true })
        .populate({
          path: 'messages',
          select: '-_id -__v -user',
        })
        .select('-_id -__v -user')
        .lean()) as (t.ISharedLink & { messages: t.IMessage[] }) | null;

      if (!shareWithMessages?.messages) {
        return null;
      }

      /** Filtered messages based on targetMessageId if present (branch-specific sharing) */
      let messagesToShare: t.IMessage[] = shareWithMessages.messages;
      if (shareWithMessages.targetMessageId) {
        messagesToShare = getMessagesUpToTarget(shareWithMessages.messages, shareWithMessages.targetMessageId);
      }

      const newConvoId = anonymizeConvoId(shareWithMessages.conversationId);
      const result: t.SharedMessagesResult = {
        shareId: shareWithMessages.shareId || shareId,
        title: shareWithMessages.title,
        isPublic: shareWithMessages.isPublic,
        createdAt: shareWithMessages.createdAt,
        updatedAt: shareWithMessages.updatedAt,
        conversationId: newConvoId,
        messages: anonymizeMessages(messagesToShare, newConvoId),
      };

      return result;
    } catch (error) {
      logger.error('[getSharedMessages] Error getting share link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        shareId,
      });
      throw new ShareServiceError('Error getting share link', 'SHARE_FETCH_ERROR');
    }
  }

  /**
   * Get shared links for a specific user with pagination and search
   */
  async function getSharedLinks(
    user: string,
    pageParam?: Date,
    pageSize: number = 10,
    isPublic: boolean = true,
    sortBy: string = 'createdAt',
    sortDirection: string = 'desc',
    search?: string,
  ): Promise<t.SharedLinksResult> {
    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const Conversation = mongoose.models.Conversation as SchemaWithMeiliMethods;
      const query: FilterQuery<t.ISharedLink> = { user, isPublic };

      if (pageParam) {
        if (sortDirection === 'desc') {
          query[sortBy] = { $lt: pageParam };
        } else {
          query[sortBy] = { $gt: pageParam };
        }
      }

      if (search && search.trim()) {
        try {
          const searchResults = await Conversation.meiliSearch(search, {
            filter: `user = "${user}"`,
          });

          if (!searchResults?.hits?.length) {
            return {
              links: [],
              nextCursor: undefined,
              hasNextPage: false,
            };
          }

          const conversationIds = searchResults.hits.map((hit) => hit.conversationId);
          query['conversationId'] = { $in: conversationIds };
        } catch (searchError) {
          logger.error('[getSharedLinks] Meilisearch error', {
            error: searchError instanceof Error ? searchError.message : 'Unknown error',
            user,
          });
          return {
            links: [],
            nextCursor: undefined,
            hasNextPage: false,
          };
        }
      }

      const sort: Record<string, 1 | -1> = {};
      sort[sortBy] = sortDirection === 'desc' ? -1 : 1;

      const sharedLinks = await SharedLink.find(query)
        .sort(sort)
        .limit(pageSize + 1)
        .select('-__v -user')
        .lean();

      const hasNextPage = sharedLinks.length > pageSize;
      const links = sharedLinks.slice(0, pageSize);

      const nextCursor = hasNextPage
        ? (links[links.length - 1][sortBy as keyof t.ISharedLink] as Date)
        : undefined;

      return {
        links: links.map((link) => ({
          shareId: link.shareId || '',
          title: link?.title || 'Untitled',
          isPublic: link.isPublic,
          createdAt: link.createdAt || new Date(),
          conversationId: link.conversationId,
        })),
        nextCursor,
        hasNextPage,
      };
    } catch (error) {
      logger.error('[getSharedLinks] Error getting shares', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
      });
      throw new ShareServiceError('Error getting shares', 'SHARES_FETCH_ERROR');
    }
  }

  /**
   * Delete all shared links for a user
   */
  async function deleteAllSharedLinks(user: string): Promise<t.DeleteAllSharesResult> {
    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const result = await SharedLink.deleteMany({ user });
      return {
        message: 'All shared links deleted successfully',
        deletedCount: result.deletedCount,
      };
    } catch (error) {
      logger.error('[deleteAllSharedLinks] Error deleting shared links', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
      });
      throw new ShareServiceError('Error deleting shared links', 'BULK_DELETE_ERROR');
    }
  }

  /**
   * Delete shared links by conversation ID
   */
  async function deleteConvoSharedLink(
    user: string,
    conversationId: string,
    req?: any, // Optional Express request object for Solid storage support
  ): Promise<t.DeleteAllSharesResult> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      
      // Find all shares for this conversation to check if any are Solid shares
      const shares = await SharedLink.find({ user, conversationId }).lean();
      
      // If any shares are Solid shares, remove public access (user logged in via "Continue with Solid")
      if (req) {
        if (getIsSolidUser()(req)) {
          const solidShares = shares.filter(share => share.podUrl);
          for (const share of solidShares) {
            try {
              const { removePublicAccessForShare } = getSolidStorage();
              await removePublicAccessForShare(req, conversationId);
              logger.info('[deleteConvoSharedLink] Public access removed for Solid share', {
                shareId: share.shareId,
                conversationId,
              });
              // Only need to remove access once per conversation
              break;
            } catch (error) {
              logger.error('[deleteConvoSharedLink] Error removing public access for Solid share', {
                error: error instanceof Error ? error.message : 'Unknown error',
                shareId: share.shareId,
                conversationId,
              });
              // Continue with deletion even if removing public access fails
            }
          }
        }
      }
      
      const result = await SharedLink.deleteMany({ user, conversationId });
      return {
        message: 'Shared links deleted successfully',
        deletedCount: result.deletedCount,
      };
    } catch (error) {
      logger.error('[deleteConvoSharedLink] Error deleting shared links', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
      });
      throw new ShareServiceError('Error deleting shared links', 'SHARE_DELETE_ERROR');
    }
  }

  /**
   * Create a new shared link for a conversation
   */
  async function createSharedLink(
    user: string,
    conversationId: string,
    targetMessageId?: string,
    req?: any, // Optional Express request object for Solid storage support
  ): Promise<t.CreateShareResult> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }
    try {
      const Message = mongoose.models.Message as SchemaWithMeiliMethods;
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const Conversation = mongoose.models.Conversation as SchemaWithMeiliMethods;

      // Check if this is a Solid user (logged in via "Continue with Solid")
      let conversation;
      let conversationMessages;
      let podUrl: string | undefined;

      if (req && getIsSolidUser()(req)) {
        logger.info('[createSharedLink] Detected Solid user, using Solid storage path');
        // Check for existing share first (same as MongoDB)
        const existingShare = (await SharedLink.findOne({
          conversationId,
          user,
          isPublic: true,
          ...(targetMessageId && { targetMessageId }),
        })
          .select('-_id -__v -user')
          .lean()) as t.ISharedLink | null;

        if (existingShare && existingShare.isPublic) {
          logger.error('[createSharedLink] Share already exists', {
            user,
            conversationId,
            targetMessageId,
          });
          throw new ShareServiceError('Share already exists', 'SHARE_EXISTS');
        } else if (existingShare) {
          await SharedLink.deleteOne({
            conversationId,
            user,
            ...(targetMessageId && { targetMessageId }),
          });
        }

        // For Solid users, get conversation and messages from Solid Pod
        try {
          logger.info('[createSharedLink] Starting Solid share creation', {
            user,
            conversationId,
            userId: req.user?.id,
            openidId: req.user?.openidId,
          });
          
          const {
            getConvoFromSolid,
            getMessagesFromSolid,
            getPodUrl,
            getSolidFetch,
          } = getSolidStorage();
          const authenticatedFetch = await getSolidFetch(req);
          
          // Get Pod URL
          podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);
          logger.info('[createSharedLink] Pod URL retrieved', {
            podUrl,
            conversationId,
          });
          
          // Get conversation from Solid
          try {
            logger.info('[createSharedLink] Getting conversation from Solid Pod', {
              user,
              conversationId,
              podUrl,
              userId: req.user?.id,
              openidId: req.user?.openidId,
            });
            conversation = await getConvoFromSolid(req, conversationId);
            if (!conversation) {
              logger.error('[createSharedLink] Conversation not found in Solid Pod (returned null)', {
                user,
                conversationId,
                podUrl,
                userId: req.user?.id,
                openidId: req.user?.openidId,
                userIdType: typeof req.user?.id,
              });
              throw new ShareServiceError(
                'Conversation not found or access denied',
                'CONVERSATION_NOT_FOUND',
              );
            }
            logger.info('[createSharedLink] Conversation retrieved from Solid Pod', {
              conversationId,
              hasTitle: !!conversation.title,
              conversationUserId: conversation.user,
              conversationUserIdType: typeof conversation.user,
              requestUserId: req.user?.id,
              requestUserIdType: typeof req.user?.id,
              userIdsMatch: String(conversation.user) === String(req.user?.id),
            });
          } catch (convoError) {
            if (convoError instanceof ShareServiceError) {
              throw convoError;
            }
            logger.error('[createSharedLink] Error calling getConvoFromSolid', {
              error: convoError instanceof Error ? convoError.message : 'Unknown error',
              errorStack: convoError instanceof Error ? convoError.stack : undefined,
              errorName: convoError instanceof Error ? convoError.name : undefined,
              user,
              conversationId,
              podUrl,
              userId: req.user?.id,
              openidId: req.user?.openidId,
            });
            throw new ShareServiceError(
              'Conversation not found or access denied',
              'CONVERSATION_NOT_FOUND',
            );
          }

          // Get messages from Solid
          conversationMessages = await getMessagesFromSolid(req, conversationId);
          if (!conversationMessages || conversationMessages.length === 0) {
            logger.error('[createSharedLink] No messages found in Solid Pod', {
              user,
              conversationId,
            });
            throw new ShareServiceError('No messages to share', 'NO_MESSAGES');
          }
        } catch (error) {
          if (error instanceof ShareServiceError) {
            throw error;
          }
          logger.error('[createSharedLink] Error getting conversation/messages from Solid Pod', {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
            user,
            conversationId,
          });
          throw new ShareServiceError('Error accessing Solid Pod', 'SOLID_ACCESS_ERROR');
        }
      } else {
        // For MongoDB users, use existing logic
        const [existingShare, mongoMessages] = await Promise.all([
        SharedLink.findOne({
          conversationId,
          user,
          isPublic: true,
          ...(targetMessageId && { targetMessageId }),
        })
          .select('-_id -__v -user')
          .lean() as Promise<t.ISharedLink | null>,
        Message.find({ conversationId, user }).sort({ createdAt: 1 }).lean(),
      ]);

      if (existingShare && existingShare.isPublic) {
        logger.error('[createSharedLink] Share already exists', {
          user,
          conversationId,
          targetMessageId,
        });
        throw new ShareServiceError('Share already exists', 'SHARE_EXISTS');
      } else if (existingShare) {
        await SharedLink.deleteOne({
          conversationId,
          user,
          ...(targetMessageId && { targetMessageId }),
        });
      }

        conversation = (await Conversation.findOne({ conversationId, user }).lean()) as {
        title?: string;
      } | null;

      // Check if user owns the conversation
      if (!conversation) {
        throw new ShareServiceError(
          'Conversation not found or access denied',
          'CONVERSATION_NOT_FOUND',
        );
      }

      // Check if there are any messages to share
        if (!mongoMessages || mongoMessages.length === 0) {
        throw new ShareServiceError('No messages to share', 'NO_MESSAGES');
        }

        conversationMessages = mongoMessages;
      }

      const title = conversation.title || 'Untitled';

      const shareId = nanoid();
      
      // Create SharedLink with podUrl if Solid user
      const sharedLinkData: any = {
        shareId,
        conversationId,
        title,
        user,
        ...(targetMessageId && { targetMessageId }),
      };

      if (podUrl) {
        sharedLinkData.podUrl = podUrl;
        // For Solid, we don't store message ObjectIds, but we still need the array for schema compatibility
        sharedLinkData.messages = [];
      } else {
        // For MongoDB, store message ObjectIds
        sharedLinkData.messages = conversationMessages;
      }

      await SharedLink.create(sharedLinkData);

      // For Solid users, set public access on conversation and messages
      if (req && podUrl) {
        try {
          const { setPublicAccessForShare } = getSolidStorage();
          await setPublicAccessForShare(req, conversationId);
          logger.info('[createSharedLink] Public access set for Solid share', {
            shareId,
            conversationId,
          });
        } catch (error) {
          logger.error('[createSharedLink] Error setting public access for Solid share', {
            error: error instanceof Error ? error.message : 'Unknown error',
            shareId,
            conversationId,
          });
          // Delete the SharedLink if setting public access fails
          await SharedLink.deleteOne({ shareId });
          throw new ShareServiceError('Error setting public access', 'SOLID_ACCESS_ERROR');
        }
      }

      return { shareId, conversationId };
    } catch (error) {
      if (error instanceof ShareServiceError) {
        throw error;
      }
      logger.error('[createSharedLink] Error creating shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
        targetMessageId,
      });
      throw new ShareServiceError('Error creating shared link', 'SHARE_CREATE_ERROR');
    }
  }

  /**
   * Get a shared link for a conversation
   */
  async function getSharedLink(
    user: string,
    conversationId: string,
  ): Promise<t.GetShareLinkResult> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const share = (await SharedLink.findOne({ conversationId, user, isPublic: true })
        .select('shareId -_id')
        .lean()) as { shareId?: string } | null;

      if (!share) {
        return { shareId: null, success: false };
      }

      return { shareId: share.shareId || null, success: true };
    } catch (error) {
      logger.error('[getSharedLink] Error getting shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
      });
      throw new ShareServiceError('Error getting shared link', 'SHARE_FETCH_ERROR');
    }
  }

  /**
   * Update a shared link with new messages
   */
  async function updateSharedLink(user: string, shareId: string): Promise<t.UpdateShareResult> {
    if (!user || !shareId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const Message = mongoose.models.Message as SchemaWithMeiliMethods;
      const share = (await SharedLink.findOne({ shareId, user })
        .select('-_id -__v -user')
        .lean()) as t.ISharedLink | null;

      if (!share) {
        throw new ShareServiceError('Share not found', 'SHARE_NOT_FOUND');
      }

      const updatedMessages = await Message.find({ conversationId: share.conversationId, user })
        .sort({ createdAt: 1 })
        .lean();

      const newShareId = nanoid();
      const update = {
        messages: updatedMessages,
        user,
        shareId: newShareId,
      };

      const updatedShare = (await SharedLink.findOneAndUpdate({ shareId, user }, update, {
        new: true,
        upsert: false,
        runValidators: true,
      }).lean()) as t.ISharedLink | null;

      if (!updatedShare) {
        throw new ShareServiceError('Share update failed', 'SHARE_UPDATE_ERROR');
      }

      anonymizeConvo(updatedShare);

      return { shareId: newShareId, conversationId: updatedShare.conversationId };
    } catch (error) {
      logger.error('[updateSharedLink] Error updating shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        shareId,
      });
      throw new ShareServiceError(
        error instanceof ShareServiceError ? error.message : 'Error updating shared link',
        error instanceof ShareServiceError ? error.code : 'SHARE_UPDATE_ERROR',
      );
    }
  }

  /**
   * Delete a shared link
   */
  async function deleteSharedLink(
    user: string,
    shareId: string,
    req?: any, // Optional Express request object for Solid storage support
  ): Promise<t.DeleteShareResult | null> {
    if (!user || !shareId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const share = await SharedLink.findOne({ shareId, user }).lean();

      if (!share) {
        return null;
      }

      // If this is a Solid share, remove public access before deleting
      if (share.podUrl && req) {
        try {
          const { removePublicAccessForShare } = getSolidStorage();
          await removePublicAccessForShare(req, share.conversationId);
          logger.info('[deleteSharedLink] Public access removed for Solid share', {
            shareId,
            conversationId: share.conversationId,
          });
        } catch (error) {
          logger.error('[deleteSharedLink] Error removing public access for Solid share', {
            error: error instanceof Error ? error.message : 'Unknown error',
            shareId,
            conversationId: share.conversationId,
          });
          // Continue with deletion even if removing public access fails
        }
      }

      // Delete the SharedLink
      const result = await SharedLink.findOneAndDelete({ shareId, user }).lean();

      if (!result) {
        return null;
      }

      return {
        success: true,
        shareId,
        message: 'Share deleted successfully',
      };
    } catch (error) {
      logger.error('[deleteSharedLink] Error deleting shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        shareId,
      });
      throw new ShareServiceError('Error deleting shared link', 'SHARE_DELETE_ERROR');
    }
  }

  // Return all methods
  return {
    getSharedLink,
    getSharedLinks,
    createSharedLink,
    updateSharedLink,
    deleteSharedLink,
    getSharedMessages,
    deleteAllSharedLinks,
    deleteConvoSharedLink,
  };
}

export type ShareMethods = ReturnType<typeof createShareMethods>;
