const express = require('express');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  getSharedMessages,
  createSharedLink,
  updateSharedLink,
  deleteSharedLink,
  getSharedLinks,
  getSharedLink,
} = require('~/models');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const router = express.Router();

/**
 * Shared messages
 */
const allowSharedLinks =
  process.env.ALLOW_SHARED_LINKS === undefined || isEnabled(process.env.ALLOW_SHARED_LINKS);

if (allowSharedLinks) {
  const allowSharedLinksPublic =
    process.env.ALLOW_SHARED_LINKS_PUBLIC === undefined ||
    isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC);
  router.get(
    '/:shareId',
    allowSharedLinksPublic ? (req, res, next) => next() : requireJwtAuth,
    async (req, res) => {
      try {
        const share = await getSharedMessages(req.params.shareId);

        if (share) {
          res.status(200).json(share);
        } else {
          res.status(404).end();
        }
      } catch (error) {
        logger.error('Error getting shared messages:', error);
        res.status(500).json({ message: 'Error getting shared messages' });
      }
    },
  );
}

/**
 * Shared links
 */
router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const params = {
      pageParam: req.query.cursor,
      pageSize: Math.max(1, parseInt(req.query.pageSize) || 10),
      isPublic: isEnabled(req.query.isPublic),
      sortBy: ['createdAt', 'title'].includes(req.query.sortBy) ? req.query.sortBy : 'createdAt',
      sortDirection: ['asc', 'desc'].includes(req.query.sortDirection)
        ? req.query.sortDirection
        : 'desc',
      search: req.query.search ? decodeURIComponent(req.query.search.trim()) : undefined,
    };

    const result = await getSharedLinks(
      req.user.id,
      params.pageParam,
      params.pageSize,
      params.isPublic,
      params.sortBy,
      params.sortDirection,
      params.search,
    );

    res.status(200).send({
      links: result.links,
      nextCursor: result.nextCursor,
      hasNextPage: result.hasNextPage,
    });
  } catch (error) {
    logger.error('Error getting shared links:', error);
    res.status(500).json({
      message: 'Error getting shared links',
      error: error.message,
    });
  }
});

router.get('/link/:conversationId', requireJwtAuth, async (req, res) => {
  try {
    const share = await getSharedLink(req.user.id, req.params.conversationId);

    return res.status(200).json({
      success: share.success,
      shareId: share.shareId,
      conversationId: req.params.conversationId,
    });
  } catch (error) {
    logger.error('Error getting shared link:', error);
    res.status(500).json({ message: 'Error getting shared link' });
  }
});

router.post('/:conversationId', requireJwtAuth, async (req, res) => {
  try {
    logger.info('[share route] Creating shared link', {
      userId: req.user.id,
      conversationId: req.params.conversationId,
      targetMessageId: req.body.targetMessageId,
      hasOpenidId: !!req.user.openidId,
      openidId: req.user.openidId,
    });
    const { targetMessageId } = req.body;
    
    // Check if createSharedLink exists
    if (typeof createSharedLink !== 'function') {
      logger.error('[share route] createSharedLink is not a function', {
        type: typeof createSharedLink,
        createSharedLink,
      });
      return res.status(500).json({ message: 'Share service not available' });
    }
    
    logger.info('[share route] Calling createSharedLink', {
      userId: req.user.id,
      conversationId: req.params.conversationId,
      targetMessageId,
      hasReq: !!req,
    });
    
    const created = await createSharedLink(req.user.id, req.params.conversationId, targetMessageId, req);
    
    logger.info('[share route] createSharedLink returned', {
      hasResult: !!created,
      resultType: typeof created,
    });
    
    if (created) {
      res.status(200).json(created);
    } else {
      res.status(404).end();
    }
  } catch (error) {
    console.error('[share route] Error caught:', error);
    logger.error('Error creating shared link:', {
      error: error?.message || String(error),
      errorName: error?.name,
      errorCode: error?.code,
      stack: error?.stack,
      errorType: typeof error,
      errorString: String(error),
      errorKeys: error ? Object.keys(error) : [],
      userId: req.user?.id,
      conversationId: req.params?.conversationId,
      fullError: error,
    });
    const errorMessage = error?.message || error?.code || 'Error creating shared link';
    res.status(500).json({ message: errorMessage });
  }
});

router.patch('/:shareId', requireJwtAuth, async (req, res) => {
  try {
    const updatedShare = await updateSharedLink(req.user.id, req.params.shareId);
    if (updatedShare) {
      res.status(200).json(updatedShare);
    } else {
      res.status(404).end();
    }
  } catch (error) {
    logger.error('Error updating shared link:', error);
    res.status(500).json({ message: 'Error updating shared link' });
  }
});

router.delete('/:shareId', requireJwtAuth, async (req, res) => {
  try {
    const result = await deleteSharedLink(req.user.id, req.params.shareId, req);

    if (!result) {
      return res.status(404).json({ message: 'Share not found' });
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error deleting shared link:', error);
    return res.status(400).json({ message: 'Error deleting shared link' });
  }
});

module.exports = router;
