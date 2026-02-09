const { logger } = require('@librechat/data-schemas');
const fetch = require('node-fetch');
const { DataFactory, Writer } = require('n3');
const {
  getFile,
  saveFileInContainer,
  overwriteFile,
  deleteFile,
  getPodUrlAll,
  createContainerAt,
} = require('@inrupt/solid-client');

// ACL/ACP namespaces
const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const FOAF_NS = 'http://xmlns.com/foaf/0.1/';

/**
 * Solid Storage Utility Module
 * 
 * This module provides functions to interact with Solid Pods for storing
 * and retrieving messages and conversations.
 * 
 * Storage Structure:
 * {podUrl}/librechat/
 *   ├── conversations/
 *   │   └── {conversationId}.json
 *   └── messages/
 *       └── {conversationId}/
 *           └── {messageId}.json
 */

/**
 * Get authenticated fetch function from Solid session
 * 
 * @param {Object} req - Express request object
 * @returns {Promise<Function>} Authenticated fetch function
 */
async function getSolidFetch(req) {
  try {
    logger.debug('[SolidStorage] Getting authenticated fetch from session', {
      hasSession: !!req.session,
      sessionId: req.sessionID,
      hasUser: !!req.user,
      userId: req.user?.id,
      openidId: req.user?.openidId,
    });

    // Check if user is authenticated with Solid/OpenID
    if (!req.user || !req.user.openidId) {
      logger.error('[SolidStorage] User not authenticated with Solid/OpenID', {
        hasUser: !!req.user,
        hasOpenidId: !!req.user?.openidId,
      });
      throw new Error('User not authenticated with Solid/OpenID');
    }

    let accessToken = null;
    let tokenSource = 'unknown';

    // Try to get access token from multiple sources (in order of preference)
    
    // Source 1: Session (tokens stored during OAuth callback)
    const openidTokens = req.session?.openidTokens;
    if (openidTokens && openidTokens.accessToken) {
      accessToken = openidTokens.accessToken;
      tokenSource = 'session';
      logger.debug('[SolidStorage] Access token found in session', {
        tokenLength: accessToken?.length,
        expiresAt: openidTokens.expiresAt,
        isExpired: openidTokens.expiresAt ? Date.now() > openidTokens.expiresAt : 'unknown',
      });
    }
    
    // Source 2: Cookies (fallback if session not available)
    if (!accessToken && req.cookies?.openid_access_token) {
      accessToken = req.cookies.openid_access_token;
      tokenSource = 'cookies';
      logger.debug('[SolidStorage] Access token found in cookies', {
        tokenLength: accessToken?.length,
      });
    }
    
    // Source 3: User object tokenset (from OAuth callback - if stored in DB)
    if (!accessToken && req.user.tokenset && req.user.tokenset.access_token) {
      accessToken = req.user.tokenset.access_token;
      tokenSource = 'user.tokenset';
      logger.debug('[SolidStorage] Access token found in user.tokenset', {
        tokenLength: accessToken?.length,
      });
    }
    
    // Source 4: User object federatedTokens (from OAuth callback - if stored in DB)
    if (!accessToken && req.user.federatedTokens && req.user.federatedTokens.access_token) {
      accessToken = req.user.federatedTokens.access_token;
      tokenSource = 'user.federatedTokens';
      logger.debug('[SolidStorage] Access token found in user.federatedTokens', {
        tokenLength: accessToken?.length,
      });
    }

    if (!accessToken) {
      // Check if session exists but wasn't loaded
      const sessionCookie = req.cookies?.['connect.sid'] || req.cookies?.connect_sid;
      logger.error('[SolidStorage] No OpenID access token found in any source', {
        hasSession: !!req.session,
        sessionId: req.sessionID,
        hasSessionCookie: !!sessionCookie,
        sessionCookieName: sessionCookie ? 'present' : 'missing',
        hasOpenidTokens: !!openidTokens,
        hasCookies: !!req.cookies,
        hasOpenidCookie: !!req.cookies?.openid_access_token,
        hasTokenset: !!req.user.tokenset,
        hasFederatedTokens: !!req.user.federatedTokens,
        sessionHasAccessToken: !!openidTokens?.accessToken,
        tokensetHasAccessToken: !!req.user.tokenset?.access_token,
        federatedTokensHasAccessToken: !!req.user.federatedTokens?.access_token,
        cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
        allCookies: req.cookies ? Object.keys(req.cookies).join(', ') : 'none',
      });
      throw new Error('No OpenID access token found. Make sure you logged in via Solid-OIDC and the session is maintained.');
    }
    logger.info('[SolidStorage] Access token retrieved', {
      tokenSource,
      tokenLength: accessToken?.length,
      tokenPrefix: accessToken?.substring(0, 20) + '...',
    });

    // Create authenticated fetch function
    // The access token will be used in Authorization header
    const authenticatedFetch = async (url, options = {}) => {
      const headers = {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': options.headers?.['Content-Type'] || 'application/json',
      };

      logger.debug('[SolidStorage] Making authenticated request', {
        url: url.toString(),
        method: options.method || 'GET',
        hasAuthHeader: !!headers.Authorization,
      });

      try {
        const response = await fetch(url, {
          ...options,
          headers,
        });

        logger.debug('[SolidStorage] Request response', {
          url: url.toString(),
          status: response.status,
          statusText: response.statusText,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unable to read error response');
          logger.error('[SolidStorage] Request failed', {
            url: url.toString(),
            status: response.status,
            statusText: response.statusText,
            error: errorText,
          });
        }

        return response;
      } catch (error) {
        logger.error('[SolidStorage] Fetch error', {
          url: url.toString(),
          error: error.message,
          stack: error.stack,
        });
        throw error;
      }
    };

    logger.info('[SolidStorage] Authenticated fetch function created successfully');
    return authenticatedFetch;
  } catch (error) {
    logger.error('[SolidStorage] Error getting authenticated fetch', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get user's Pod URL from their WebID
 * 
 * @param {string} webId - User's WebID
 * @param {Function} fetch - Authenticated fetch function
 * @returns {Promise<string>} Primary Pod URL
 */
async function getPodUrl(webId, fetch) {
  try {
    logger.debug('[SolidStorage] Getting Pod URL from WebID', { webId });

    if (!webId) {
      logger.error('[SolidStorage] WebID is required');
      throw new Error('WebID is required');
    }

    if (!fetch) {
      logger.error('[SolidStorage] Fetch function is required');
      throw new Error('Fetch function is required');
    }

    // Try to get Pod URLs from profile
    let podUrls = [];
    try {
      podUrls = await getPodUrlAll(webId, { fetch });
      logger.debug('[SolidStorage] Pod URLs retrieved from profile', {
        webId,
        podCount: podUrls?.length || 0,
        podUrls: podUrls || [],
      });
    } catch (error) {
      logger.warn('[SolidStorage] Failed to get Pod URLs from profile, will try fallback', {
        webId,
        error: error.message,
      });
    }

    // If no Pod URLs found, derive from WebID as fallback
    if (!podUrls || podUrls.length === 0) {
      logger.info('[SolidStorage] No Pod URLs found in profile, deriving from WebID', { webId });
      
      // Extract base URL from WebID
      // WebID format: http://localhost:3000/bisi/profile/card#me
      // Pod URL format: http://localhost:3000/bisi/
      try {
        const webIdUrl = new URL(webId);
        // Remove the fragment (#me) and path segments after the pod identifier
        // For most Solid servers, the Pod is at the root or one level deep
        // Pattern: http://host:port/podId/ -> Pod URL
        const pathParts = webIdUrl.pathname.split('/').filter(p => p);
        
        // If path contains 'profile', 'card', or similar, remove them
        // The Pod is usually at the base or one level up
        let podPath = '/';
        if (pathParts.length > 0) {
          // For pattern like /bisi/profile/card, Pod is at /bisi/
          // For pattern like /profile/card, Pod is at /
          const podIdentifier = pathParts[0];
          if (podIdentifier && podIdentifier !== 'profile' && podIdentifier !== 'card') {
            podPath = `/${podIdentifier}/`;
          }
        }
        
        const derivedPodUrl = `${webIdUrl.protocol}//${webIdUrl.host}${podPath}`;
        logger.info('[SolidStorage] Derived Pod URL from WebID', {
          webId,
          derivedPodUrl,
          pathParts,
        });
        
        // Verify the Pod URL is accessible by trying to fetch the root
        try {
          const response = await fetch(derivedPodUrl, {
            method: 'HEAD',
          });
          if (response.ok || response.status === 401 || response.status === 403) {
            // 401/403 means the Pod exists but we need auth (which is expected)
            logger.info('[SolidStorage] Derived Pod URL is accessible', {
              derivedPodUrl,
              status: response.status,
            });
            return derivedPodUrl;
          }
        } catch (verifyError) {
          logger.warn('[SolidStorage] Could not verify derived Pod URL, using it anyway', {
            derivedPodUrl,
            error: verifyError.message,
          });
        }
        
        return derivedPodUrl;
      } catch (urlError) {
        logger.error('[SolidStorage] Failed to derive Pod URL from WebID', {
          webId,
          error: urlError.message,
        });
        throw new Error(`Could not determine Pod URL from WebID: ${webId}`);
      }
    }

    const primaryPodUrl = podUrls[0];
    logger.info('[SolidStorage] Primary Pod URL determined', {
      webId,
      primaryPodUrl,
      totalPods: podUrls.length,
    });

    return primaryPodUrl;
  } catch (error) {
    logger.error('[SolidStorage] Error getting Pod URL', {
      webId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get base storage path for LibreChat data in Pod
 * 
 * @param {string} podUrl - Pod URL
 * @returns {string} Base storage path
 */
function getBaseStoragePath(podUrl) {
  const basePath = `${podUrl}librechat/`;
  logger.debug('[SolidStorage] Base storage path', { podUrl, basePath });
  return basePath;
}

/**
 * Get conversation file path
 * 
 * @param {string} podUrl - Pod URL
 * @param {string} conversationId - Conversation ID
 * @returns {string} Conversation file path
 */
function getConversationPath(podUrl, conversationId) {
  const path = `${getBaseStoragePath(podUrl)}conversations/${conversationId}.json`;
  logger.debug('[SolidStorage] Conversation path', { conversationId, path });
  return path;
}

/**
 * Get messages container path for a conversation
 * 
 * @param {string} podUrl - Pod URL
 * @param {string} conversationId - Conversation ID
 * @returns {string} Messages container path
 */
function getMessagesContainerPath(podUrl, conversationId) {
  const path = `${getBaseStoragePath(podUrl)}messages/${conversationId}/`;
  logger.debug('[SolidStorage] Messages container path', { conversationId, path });
  return path;
}

/**
 * Get message file path
 * 
 * @param {string} podUrl - Pod URL
 * @param {string} conversationId - Conversation ID
 * @param {string} messageId - Message ID
 * @returns {string} Message file path
 */
function getMessagePath(podUrl, conversationId, messageId) {
  const path = `${getMessagesContainerPath(podUrl, conversationId)}${messageId}.json`;
  logger.debug('[SolidStorage] Message path', { conversationId, messageId, path });
  return path;
}

/**
 * Ensure container exists, create if it doesn't
 * 
 * @param {string} containerUrl - Container URL
 * @param {Function} fetch - Authenticated fetch function
 * @returns {Promise<void>}
 */
async function ensureContainerExists(containerUrl, fetch) {
  try {
    logger.debug('[SolidStorage] Ensuring container exists', { containerUrl });

    try {
      // Try to check if container exists using HEAD request
      const response = await fetch(containerUrl, {
        method: 'HEAD',
      });
      
      if (response.ok || response.status === 200 || response.status === 405) {
        // Container exists (405 Method Not Allowed is also OK - means container exists but doesn't support HEAD)
        logger.debug('[SolidStorage] Container already exists', { 
          containerUrl,
          status: response.status,
        });
        return;
      }
      
      // If we get here, container might not exist
      if (response.status === 404) {
        throw new Error('Container not found');
      }
    } catch (error) {
      // Container doesn't exist, create it
      if (error.status === 404 || error.message?.includes('404') || error.message?.includes('not found') || error.message?.includes('Container not found')) {
        logger.info('[SolidStorage] Container does not exist, creating', { containerUrl });
        try {
          await createContainerAt(containerUrl, { fetch });
          logger.info('[SolidStorage] Container created successfully', { containerUrl });
        } catch (createError) {
          // If creation fails with 409, container already exists (race condition)
          if (createError.status === 409 || createError.message?.includes('409') || createError.message?.includes('already exists')) {
            logger.debug('[SolidStorage] Container already exists (race condition)', { containerUrl });
            return;
          }
          throw createError;
        }
      } else {
        logger.error('[SolidStorage] Error checking container existence', {
          containerUrl,
          error: error.message,
          errorStatus: error.status,
        });
        throw error;
      }
    }
  } catch (error) {
    logger.error('[SolidStorage] Error ensuring container exists', {
      containerUrl,
      error: error.message,
      errorStatus: error.status,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Ensure base storage structure exists
 * 
 * @param {string} podUrl - Pod URL
 * @param {Function} fetch - Authenticated fetch function
 * @returns {Promise<void>}
 */
async function ensureBaseStructure(podUrl, fetch) {
  try {
    logger.debug('[SolidStorage] Ensuring base storage structure exists', { podUrl });

    const basePath = getBaseStoragePath(podUrl);
    const conversationsPath = `${basePath}conversations/`;
    const messagesPath = `${basePath}messages/`;

    // Ensure base librechat container
    await ensureContainerExists(basePath, fetch);

    // Ensure conversations container
    await ensureContainerExists(conversationsPath, fetch);

    // Ensure messages container
    await ensureContainerExists(messagesPath, fetch);

    logger.info('[SolidStorage] Base storage structure ensured', {
      podUrl,
      basePath,
      conversationsPath,
      messagesPath,
    });
  } catch (error) {
    logger.error('[SolidStorage] Error ensuring base structure', {
      podUrl,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Save a message to Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Object} messageData - Message data to save
 * @param {string} messageData.messageId - Message ID
 * @param {string} messageData.conversationId - Conversation ID
 * @param {string} messageData.text - Message text
 * @param {string} messageData.sender - Sender identifier
 * @param {boolean} messageData.isCreatedByUser - Whether message was created by user
 * @param {string} messageData.endpoint - Endpoint where message originated
 * @param {string} [messageData.parentMessageId] - Parent message ID
 * @param {string} [messageData.error] - Error message
 * @param {boolean} [messageData.unfinished] - Whether message is unfinished
 * @param {Array} [messageData.files] - Files associated with message
 * @param {string} [messageData.finish_reason] - Finish reason
 * @param {number} [messageData.tokenCount] - Token count
 * @param {string} [messageData.plugin] - Plugin name
 * @param {Array} [messageData.plugins] - Plugin array
 * @param {string} [messageData.model] - Model used
 * @param {Date} [messageData.expiredAt] - Expiration date
 * @param {Object} [metadata] - Additional metadata
 * @returns {Promise<Object>} Saved message data
 */
async function saveMessageToSolid(req, messageData, metadata) {
  try {
    logger.info('[SolidStorage] Saving message to Solid Pod', {
      messageId: messageData.messageId,
      conversationId: messageData.conversationId,
      context: metadata?.context,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!messageData.messageId) {
      throw new Error('messageId is required');
    }

    if (!messageData.conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Ensure base structure exists
    await ensureBaseStructure(podUrl, authenticatedFetch);

    // Ensure messages container for this conversation exists
    const messagesContainerPath = getMessagesContainerPath(podUrl, messageData.conversationId);
    await ensureContainerExists(messagesContainerPath, authenticatedFetch);

    // Prepare message object with all fields
    const messageToSave = {
      messageId: messageData.newMessageId || messageData.messageId,
      conversationId: messageData.conversationId,
      user: req.user.id,
      text: messageData.text || '',
      content: messageData.content || undefined, // For agent endpoints, content is an array
      sender: messageData.sender,
      isCreatedByUser: messageData.isCreatedByUser,
      endpoint: messageData.endpoint,
      parentMessageId: messageData.parentMessageId || null,
      error: messageData.error || null,
      unfinished: messageData.unfinished || false,
      files: messageData.files || [],
      finish_reason: messageData.finish_reason || null,
      tokenCount: messageData.tokenCount || 0,
      plugin: messageData.plugin || null,
      plugins: messageData.plugins || [],
      model: messageData.model || null,
      expiredAt: messageData.expiredAt || null,
      createdAt: messageData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Get message file path
    const messagePath = getMessagePath(
      podUrl,
      messageData.conversationId,
      messageToSave.messageId
    );

    // Convert message to JSON string
    const messageJson = JSON.stringify(messageToSave, null, 2);
    
    // Use Buffer for Node.js compatibility (Blob is available in Node 18+ but Buffer is more universal)
    const messageBuffer = Buffer.from(messageJson, 'utf-8');

    logger.debug('[SolidStorage] Saving message file', {
      messagePath,
      messageId: messageToSave.messageId,
      conversationId: messageToSave.conversationId,
      textLength: messageToSave.text?.length || 0,
      hasContent: !!messageToSave.content,
      contentLength: Array.isArray(messageToSave.content) ? messageToSave.content.length : 0,
      contentTypes: Array.isArray(messageToSave.content) 
        ? messageToSave.content.map(c => c?.type).filter(Boolean)
        : [],
      bufferSize: messageBuffer.length,
    });

    // Check if message already exists (for update vs create)
    let messageExists = false;
    try {
      await getFile(messagePath, { fetch: authenticatedFetch });
      messageExists = true;
      logger.debug('[SolidStorage] Message file already exists, will overwrite', {
        messagePath,
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        messageExists = false;
        logger.debug('[SolidStorage] Message file does not exist, will create', {
          messagePath,
        });
      } else {
        // Some other error occurred, log it but continue
        logger.warn('[SolidStorage] Error checking if message exists, will try to save anyway', {
          messagePath,
          error: error.message,
        });
      }
    }

    // Save or overwrite the message file
    if (messageExists) {
      await overwriteFile(messagePath, messageBuffer, {
        contentType: 'application/json',
        fetch: authenticatedFetch,
      });
      logger.info('[SolidStorage] Message file overwritten successfully', {
        messagePath,
        messageId: messageToSave.messageId,
      });
    } else {
      await saveFileInContainer(messagesContainerPath, messageBuffer, {
        slug: `${messageToSave.messageId}.json`,
        contentType: 'application/json',
        fetch: authenticatedFetch,
      });
      logger.info('[SolidStorage] Message file saved successfully', {
        messagePath,
        messageId: messageToSave.messageId,
      });
    }

    if (metadata?.context) {
      logger.info(`[SolidStorage] ---saveMessageToSolid context: ${metadata.context}`);
    }

    return messageToSave;
  } catch (error) {
    logger.error('[SolidStorage] Error saving message to Solid Pod', {
      messageId: messageData?.messageId,
      conversationId: messageData?.conversationId,
      error: error.message,
      stack: error.stack,
      context: metadata?.context,
    });
    throw error;
  }
}

/**
 * Get all messages for a conversation from Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<Array>} Array of message objects, sorted by createdAt
 */
async function getMessagesFromSolid(req, conversationId) {
  try {
    logger.info('[SolidStorage] Getting messages from Solid Pod', {
      conversationId,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get messages container path
    const messagesContainerPath = getMessagesContainerPath(podUrl, conversationId);

    logger.debug('[SolidStorage] Reading messages container', {
      messagesContainerPath,
      conversationId,
    });

    // Get all files in the messages container
    // Solid Pods return Turtle (RDF) format with ldp:contains predicates
    let messageFiles = [];
    try {
      const response = await authenticatedFetch(messagesContainerPath, {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle, application/ld+json, */*',
        },
      });
      
      if (response.status === 404) {
        // Container doesn't exist, return empty array
        logger.info('[SolidStorage] Messages container does not exist, returning empty array', {
          messagesContainerPath,
        });
        return [];
      }
      
      if (!response.ok) {
        throw new Error(`Failed to get container contents: ${response.status} ${response.statusText}`);
      }
      
      // Parse the response (Solid containers return Turtle format)
      // Format: ldp:contains <item1>, <item2>, <item3>.
      const text = await response.text();
      
      // Parse Turtle format to extract all items from ldp:contains
      // Handle both single and comma-separated items
      const ldpContainsPattern = /ldp:contains\s+((?:<[^>]+>(?:\s*,\s*<[^>]+>)*))/g;
      const allItems = [];
      let match;
      
      while ((match = ldpContainsPattern.exec(text)) !== null) {
        // Extract all URLs from the matched group (handles comma-separated items)
        const itemsString = match[1];
        const itemPattern = /<([^>]+)>/g;
        let itemMatch;
        while ((itemMatch = itemPattern.exec(itemsString)) !== null) {
          const itemUrl = itemMatch[1];
          // Convert relative URLs to absolute URLs
          const absoluteUrl = itemUrl.startsWith('http') 
            ? itemUrl 
            : new URL(itemUrl, messagesContainerPath).href;
          allItems.push({ url: absoluteUrl });
        }
      }
      
      // Filter for JSON files only
      messageFiles = allItems.filter((item) => {
        const url = item.url || '';
        return url.endsWith('.json') && !url.endsWith('.meta.json');
      });
      
      logger.debug('[SolidStorage] Found message files', {
        conversationId,
        fileCount: messageFiles.length,
        files: messageFiles.map(f => f.url),
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        // Container doesn't exist, return empty array
        logger.info('[SolidStorage] Messages container does not exist, returning empty array', {
          messagesContainerPath,
        });
        return [];
      }
      throw error;
    }

    logger.debug('[SolidStorage] Found message files', {
      conversationId,
      fileCount: messageFiles.length,
    });

    // Read all message files
    const messages = [];
    for (const fileInfo of messageFiles) {
      try {
        const fileUrl = fileInfo.url;
        logger.debug('[SolidStorage] Reading message file', {
          fileUrl,
          conversationId,
        });

        const file = await getFile(fileUrl, { fetch: authenticatedFetch });
        const fileText = await file.text();
        const messageData = JSON.parse(fileText);

        // Validate that this message belongs to the current user
        if (messageData.user !== req.user.id) {
          logger.warn('[SolidStorage] Message belongs to different user, skipping', {
            messageId: messageData.messageId,
            messageUserId: messageData.user,
            currentUserId: req.user.id,
          });
          continue;
        }

        // Validate that this message belongs to the requested conversation
        if (messageData.conversationId !== conversationId) {
          logger.warn('[SolidStorage] Message belongs to different conversation, skipping', {
            messageId: messageData.messageId,
            messageConversationId: messageData.conversationId,
            requestedConversationId: conversationId,
          });
          continue;
        }

        messages.push(messageData);
      } catch (error) {
        logger.error('[SolidStorage] Error reading message file', {
          fileUrl: fileInfo.url,
          conversationId,
          error: error.message,
        });
        // Continue with other files even if one fails
      }
    }

    // Sort messages by createdAt (ascending)
    messages.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateA - dateB;
    });

    logger.info('[SolidStorage] Messages retrieved successfully', {
      conversationId,
      messageCount: messages.length,
    });

    return messages;
  } catch (error) {
    logger.error('[SolidStorage] Error getting messages from Solid Pod', {
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Update an existing message in Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Object} messageData - Message data to update
 * @param {string} messageData.messageId - Message ID (required)
 * @param {string} [messageData.text] - Updated message text
 * @param {Array} [messageData.files] - Updated files array
 * @param {boolean} [messageData.isCreatedByUser] - Updated isCreatedByUser flag
 * @param {string} [messageData.sender] - Updated sender
 * @param {number} [messageData.tokenCount] - Updated token count
 * @param {string} [messageData.finish_reason] - Updated finish reason
 * @param {boolean} [messageData.unfinished] - Updated unfinished flag
 * @param {string} [messageData.error] - Updated error message
 * @param {Object} [metadata] - Additional metadata
 * @returns {Promise<Object>} Updated message data
 */
async function updateMessageInSolid(req, messageData, metadata) {
  try {
    logger.info('[SolidStorage] Updating message in Solid Pod', {
      messageId: messageData.messageId,
      context: metadata?.context,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!messageData.messageId) {
      throw new Error('messageId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // First, try to get the existing message to merge updates
    let existingMessage = null;
    let conversationId = messageData.conversationId;

    // If conversationId is not provided, we need to find it from the existing message
    if (!conversationId) {
      logger.warn('[SolidStorage] conversationId not provided in update, searching for message in Pod', {
        messageId: messageData.messageId,
        updateFields: Object.keys(messageData),
      });
      
      // Search for the message across all conversation message containers
      // We'll check the messages container for all conversation subdirectories
      const basePath = getBaseStoragePath(podUrl);
      const messagesContainerPath = `${basePath}messages/`;
      
      try {
        // Get list of all conversation directories in messages container
        const response = await authenticatedFetch(messagesContainerPath, {
          method: 'GET',
          headers: {
            'Accept': 'text/turtle, application/ld+json, */*',
          },
        });
        
        if (response.ok) {
          const text = await response.text();
          // Parse Turtle format to extract conversation directories
          const ldpContainsPattern = /ldp:contains\s+((?:<[^>]+>(?:\s*,\s*<[^>]+>)*))/g;
          const allItems = [];
          let match;
          
          while ((match = ldpContainsPattern.exec(text)) !== null) {
            const itemsString = match[1];
            const itemPattern = /<([^>]+)>/g;
            let itemMatch;
            while ((itemMatch = itemPattern.exec(itemsString)) !== null) {
              const itemUrl = itemMatch[1];
              // Only include directories (ending with /)
              if (itemUrl.endsWith('/')) {
                const absoluteUrl = itemUrl.startsWith('http') 
                  ? itemUrl 
                  : new URL(itemUrl, messagesContainerPath).href;
                allItems.push(absoluteUrl);
              }
            }
          }
          
          logger.debug('[SolidStorage] Searching for message across conversation directories', {
            messageId: messageData.messageId,
            directoryCount: allItems.length,
          });
          
          // Search each conversation directory for the message
          for (const conversationDir of allItems) {
            try {
              const messageFileUrl = `${conversationDir}${messageData.messageId}.json`;
              const fileResponse = await authenticatedFetch(messageFileUrl, { method: 'HEAD' });
              
              if (fileResponse.ok) {
                // Found the message! Extract conversationId from the directory path
                // Format: .../messages/{conversationId}/
                const pathParts = conversationDir.split('/');
                const conversationIdIndex = pathParts.findIndex(part => part === 'messages') + 1;
                if (conversationIdIndex > 0 && pathParts[conversationIdIndex]) {
                  conversationId = pathParts[conversationIdIndex];
                  logger.info('[SolidStorage] Found conversationId from message location', {
                    messageId: messageData.messageId,
                    conversationId,
                    searchPath: conversationDir,
                  });
                  break;
                }
              }
            } catch (searchError) {
              // Continue searching other directories
              logger.debug('[SolidStorage] Message not found in conversation directory', {
                conversationDir,
                messageId: messageData.messageId,
                error: searchError.message,
              });
            }
          }
        } else {
          logger.warn('[SolidStorage] Failed to list messages container', {
            messagesContainerPath,
            status: response.status,
            statusText: response.statusText,
          });
        }
      } catch (searchError) {
        logger.error('[SolidStorage] Error searching for message in Pod', {
          messageId: messageData.messageId,
          error: searchError.message,
          stack: searchError.stack,
        });
      }
      
      // If we still don't have conversationId, throw error
      if (!conversationId) {
        const error = new Error('conversationId is required for updating messages. Could not find message in Pod to determine conversationId.');
        logger.error('[SolidStorage] Failed to find conversationId for message update', {
          messageId: messageData.messageId,
          updateFields: Object.keys(messageData),
        });
        throw error;
      }
    }

    // Now we have conversationId, get the message path
    const messagePath = getMessagePath(podUrl, conversationId, messageData.messageId);

    try {
      const file = await getFile(messagePath, { fetch: authenticatedFetch });
      const fileText = await file.text();
      existingMessage = JSON.parse(fileText);

      // Validate that this message belongs to the current user
      if (existingMessage.user !== req.user.id) {
        throw new Error('Message does not belong to current user');
      }

      logger.debug('[SolidStorage] Existing message found', {
        messageId: messageData.messageId,
        conversationId,
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        throw new Error(`Message with ID ${messageData.messageId} not found`);
      }
      throw error;
    }

    // Merge existing message with updates
    // Only update content if it's explicitly provided (not undefined)
    const updatedMessage = {
      ...existingMessage,
      ...messageData,
      // Preserve content if not provided in update (for agent endpoints)
      content: messageData.content !== undefined ? messageData.content : existingMessage.content,
      messageId: existingMessage.messageId, // Don't allow changing messageId
      conversationId: existingMessage.conversationId, // Don't allow changing conversationId
      user: existingMessage.user, // Don't allow changing user
      updatedAt: new Date().toISOString(),
      // Preserve createdAt
      createdAt: existingMessage.createdAt,
    };

    // Convert to JSON and create buffer
    const messageJson = JSON.stringify(updatedMessage, null, 2);
    const messageBuffer = Buffer.from(messageJson, 'utf-8');

    logger.debug('[SolidStorage] Updating message file', {
      messagePath,
      messageId: updatedMessage.messageId,
      conversationId: updatedMessage.conversationId,
    });

    // Overwrite the message file
    await overwriteFile(messagePath, messageBuffer, {
      contentType: 'application/json',
      fetch: authenticatedFetch,
    });

    logger.info('[SolidStorage] Message updated successfully', {
      messagePath,
      messageId: updatedMessage.messageId,
    });

    if (metadata?.context) {
      logger.info(`[SolidStorage] ---updateMessageInSolid context: ${metadata.context}`);
    }

    return updatedMessage;
  } catch (error) {
    logger.error('[SolidStorage] Error updating message in Solid Pod', {
      messageId: messageData?.messageId,
      conversationId: messageData?.conversationId,
      error: error.message,
      stack: error.stack,
      context: metadata?.context,
    });
    throw error;
  }
}

/**
 * Delete messages from Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Object} params - Delete parameters
 * @param {string} params.conversationId - Conversation ID (required)
 * @param {string} [params.messageId] - If provided, delete all messages after this message
 * @param {Array<string>} [params.messageIds] - Specific message IDs to delete
 * @returns {Promise<number>} Number of messages deleted
 */
async function deleteMessagesFromSolid(req, params) {
  try {
    logger.info('[SolidStorage] Deleting messages from Solid Pod', {
      conversationId: params.conversationId,
      messageId: params.messageId,
      messageIds: params.messageIds,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!params.conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get messages container path
    const messagesContainerPath = getMessagesContainerPath(podUrl, params.conversationId);

    // Get all messages for the conversation
    const allMessages = await getMessagesFromSolid(req, params.conversationId);

    if (allMessages.length === 0) {
      logger.info('[SolidStorage] No messages found to delete', {
        conversationId: params.conversationId,
      });
      return 0;
    }

    let messagesToDelete = [];

    // Case 1: Delete messages after a specific messageId
    if (params.messageId) {
      const referenceMessage = allMessages.find((msg) => msg.messageId === params.messageId);
      if (!referenceMessage) {
        logger.warn('[SolidStorage] Reference message not found', {
          messageId: params.messageId,
          conversationId: params.conversationId,
        });
        return 0;
      }

      const referenceDate = new Date(referenceMessage.createdAt || 0);
      messagesToDelete = allMessages.filter((msg) => {
        const msgDate = new Date(msg.createdAt || 0);
        return msgDate > referenceDate;
      });

      logger.debug('[SolidStorage] Filtering messages after reference message', {
        referenceMessageId: params.messageId,
        referenceDate: referenceDate.toISOString(),
        totalMessages: allMessages.length,
        messagesToDelete: messagesToDelete.length,
      });
    }
    // Case 2: Delete specific message IDs
    else if (params.messageIds && Array.isArray(params.messageIds) && params.messageIds.length > 0) {
      messagesToDelete = allMessages.filter((msg) => params.messageIds.includes(msg.messageId));
      logger.debug('[SolidStorage] Filtering specific message IDs', {
        requestedIds: params.messageIds.length,
        foundMessages: messagesToDelete.length,
      });
    }
    // Case 3: Delete all messages (if neither messageId nor messageIds provided)
    else {
      messagesToDelete = allMessages;
      logger.debug('[SolidStorage] Deleting all messages', {
        totalMessages: allMessages.length,
      });
    }

    if (messagesToDelete.length === 0) {
      logger.info('[SolidStorage] No messages to delete after filtering', {
        conversationId: params.conversationId,
      });
      return 0;
    }

    // Delete each message file
    let deletedCount = 0;
    for (const message of messagesToDelete) {
      try {
        const messagePath = getMessagePath(podUrl, params.conversationId, message.messageId);
        
        logger.debug('[SolidStorage] Deleting message file', {
          messagePath,
          messageId: message.messageId,
        });

        await deleteFile(messagePath, { fetch: authenticatedFetch });
        deletedCount++;

        logger.debug('[SolidStorage] Message file deleted successfully', {
          messageId: message.messageId,
        });
      } catch (error) {
        if (error.status === 404 || error.message?.includes('404')) {
          // File already doesn't exist, count it as deleted
          logger.debug('[SolidStorage] Message file already deleted', {
            messageId: message.messageId,
          });
          deletedCount++;
        } else {
          logger.error('[SolidStorage] Error deleting message file', {
            messageId: message.messageId,
            error: error.message,
          });
          // Continue with other messages even if one fails
        }
      }
    }

    logger.info('[SolidStorage] Messages deleted successfully', {
      conversationId: params.conversationId,
      deletedCount,
      totalRequested: messagesToDelete.length,
    });

    return deletedCount;
  } catch (error) {
    logger.error('[SolidStorage] Error deleting messages from Solid Pod', {
      conversationId: params?.conversationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Save a conversation to Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Object} convoData - Conversation data to save
 * @param {string} convoData.conversationId - Conversation ID (required)
 * @param {string} [convoData.newConversationId] - New conversation ID (for renaming)
 * @param {string} [convoData.title] - Conversation title
 * @param {string} [convoData.endpoint] - Endpoint where conversation originated
 * @param {string} [convoData.model] - Model used
 * @param {string} [convoData.agent_id] - Agent ID
 * @param {string} [convoData.assistant_id] - Assistant ID
 * @param {string} [convoData.spec] - Spec
 * @param {string} [convoData.iconURL] - Icon URL
 * @param {Array} [convoData.messages] - Array of message references
 * @param {Array} [convoData.files] - Array of file IDs
 * @param {string} [convoData.promptPrefix] - Prompt prefix
 * @param {number} [convoData.temperature] - Temperature setting
 * @param {number} [convoData.topP] - Top P setting
 * @param {number} [convoData.presence_penalty] - Presence penalty
 * @param {number} [convoData.frequency_penalty] - Frequency penalty
 * @param {Date} [convoData.expiredAt] - Expiration date
 * @param {Object} [metadata] - Additional metadata
 * @returns {Promise<Object>} Saved conversation data
 */
async function saveConvoToSolid(req, convoData, metadata) {
  try {
    logger.info('[SolidStorage] Saving conversation to Solid Pod', {
      conversationId: convoData.conversationId,
      newConversationId: convoData.newConversationId,
      context: metadata?.context,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!convoData.conversationId && !convoData.newConversationId) {
      throw new Error('conversationId or newConversationId is required');
    }

    // Use newConversationId if provided, otherwise use conversationId
    const finalConversationId = convoData.newConversationId || convoData.conversationId;

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    // 
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Ensure base structure exists
    await ensureBaseStructure(podUrl, authenticatedFetch);

    // Get conversation file path
    const conversationPath = getConversationPath(podUrl, finalConversationId);

    // Check if conversation already exists and load it to preserve existing data
    let existingConversation = null;
    try {
      const existingFile = await getFile(conversationPath, { fetch: authenticatedFetch });
      const existingFileText = await existingFile.text();
      existingConversation = JSON.parse(existingFileText);
      logger.debug('[SolidStorage] Loaded existing conversation for merge', {
        conversationId: finalConversationId,
        hasTitle: !!existingConversation.title,
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        logger.debug('[SolidStorage] Conversation does not exist yet, will create new', {
          conversationId: finalConversationId,
        });
      } else {
        logger.warn('[SolidStorage] Error loading existing conversation, will create new', {
          conversationId: finalConversationId,
          error: error.message,
        });
      }
    }

    // Get messages for this conversation (just IDs for reference)
    // Note: We call getMessagesFromSolid directly since it's in the same module
    const messages = await getMessagesFromSolid(req, finalConversationId);
    const messageRefs = messages.map((msg) => ({
      messageId: msg.messageId,
      createdAt: msg.createdAt,
    }));

    // Start with existing conversation data if available, otherwise use defaults
    const baseConversation = existingConversation || {
      conversationId: finalConversationId,
      user: req.user.id,
      createdAt: new Date().toISOString(),
    };

    // If model or endpoint are missing, try to extract them from messages
    let finalModel = convoData.model ?? baseConversation.model;
    let finalEndpoint = convoData.endpoint ?? baseConversation.endpoint;
    
    if (!finalModel || !finalEndpoint) {
      // Find the first message with a model (usually the AI response)
      const messageWithModel = messages.find(msg => msg.model && msg.endpoint);
      
      if (messageWithModel) {
        if (!finalModel && messageWithModel.model) {
          logger.info('[SolidStorage] Extracting model from messages when saving', {
            conversationId: finalConversationId,
            extractedModel: messageWithModel.model,
          });
          finalModel = messageWithModel.model;
        }
        
        if (!finalEndpoint && messageWithModel.endpoint) {
          logger.info('[SolidStorage] Extracting endpoint from messages when saving', {
            conversationId: finalConversationId,
            extractedEndpoint: messageWithModel.endpoint,
          });
          finalEndpoint = messageWithModel.endpoint;
        }
      }
    }

    // Merge existing conversation with updates from convoData
    // convoData takes precedence for fields that are explicitly provided
    const conversationToSave = {
      ...baseConversation,
      ...convoData,
      conversationId: finalConversationId,
      user: req.user.id,
      messages: messageRefs,
      createdAt: baseConversation.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Convert to JSON and create buffer
    const conversationJson = JSON.stringify(conversationToSave, null, 2);
    const conversationBuffer = Buffer.from(conversationJson, 'utf-8');

    logger.debug('[SolidStorage] Saving conversation file', {
      conversationPath,
      conversationId: finalConversationId,
      messageCount: messageRefs.length,
    });

    // Determine if conversation exists (we already loaded it above if it exists)
    const conversationExists = existingConversation !== null;

    // If conversationId changed, delete old file
    if (convoData.newConversationId && convoData.conversationId !== convoData.newConversationId) {
      const oldConversationPath = getConversationPath(podUrl, convoData.conversationId);
      try {
        await deleteFile(oldConversationPath, { fetch: authenticatedFetch });
        logger.info('[SolidStorage] Old conversation file deleted after rename', {
          oldConversationPath,
          newConversationId: convoData.newConversationId,
        });
      } catch (error) {
        if (error.status !== 404) {
          logger.warn('[SolidStorage] Error deleting old conversation file', {
            oldConversationPath,
            error: error.message,
          });
        }
      }
    }

    // Save or overwrite the conversation file
    const conversationsContainerPath = `${getBaseStoragePath(podUrl)}conversations/`;
    if (conversationExists) {
      await overwriteFile(conversationPath, conversationBuffer, {
        contentType: 'application/json',
        fetch: authenticatedFetch,
      });
      logger.info('[SolidStorage] Conversation file overwritten successfully', {
        conversationPath,
        conversationId: finalConversationId,
      });
    } else {
      await saveFileInContainer(conversationsContainerPath, conversationBuffer, {
        slug: `${finalConversationId}.json`,
        contentType: 'application/json',
        fetch: authenticatedFetch,
      });
      logger.info('[SolidStorage] Conversation file saved successfully', {
        conversationPath,
        conversationId: finalConversationId,
      });
    }

    if (metadata?.context) {
      logger.info(`[SolidStorage] ---saveConvoToSolid context: ${metadata.context}`);
    }

    return conversationToSave;
  } catch (error) {
    logger.error('[SolidStorage] Error saving conversation to Solid Pod', {
      conversationId: convoData?.conversationId,
      newConversationId: convoData?.newConversationId,
      error: error.message,
      stack: error.stack,
      context: metadata?.context,
    });
    throw error;
  }
}

/**
 * Get a single conversation from Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<Object|null>} Conversation object or null if not found
 */
async function getConvoFromSolid(req, conversationId) {
  try {
    logger.info('[SolidStorage] Getting conversation from Solid Pod', {
      conversationId,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get conversation file path
    const conversationPath = getConversationPath(podUrl, conversationId);

    logger.debug('[SolidStorage] Reading conversation file', {
      conversationPath,
      conversationId,
    });

    try {
      const file = await getFile(conversationPath, { fetch: authenticatedFetch });
      const fileText = await file.text();
      const conversationData = JSON.parse(fileText);

      logger.info('[SolidStorage] Conversation file read successfully, checking user ID', {
        conversationId,
        conversationUserId: conversationData.user,
        conversationUserIdType: typeof conversationData.user,
        currentUserId: req.user.id,
        currentUserIdType: typeof req.user.id,
        conversationHasUser: 'user' in conversationData,
        conversationDataKeys: Object.keys(conversationData),
      });

      // Validate that this conversation belongs to the current user
      // Convert both to strings for comparison to handle ObjectId vs string mismatches
      // Handle cases where user might be an ObjectId object (MongoDB) or a string
      let conversationUserId = conversationData.user;
      if (!conversationUserId) {
        logger.error('[SolidStorage] Conversation has no user field - RETURNING NULL', {
          conversationId,
          conversationDataKeys: Object.keys(conversationData),
        });
        return null;
      }
      
      if (conversationUserId && typeof conversationUserId === 'object' && conversationUserId.toString) {
        conversationUserId = conversationUserId.toString();
      } else {
        conversationUserId = String(conversationUserId || '');
      }
      
      let currentUserId = req.user.id;
      if (!currentUserId) {
        logger.error('[SolidStorage] Request has no user ID - RETURNING NULL', {
          conversationId,
          hasUser: !!req.user,
          userKeys: req.user ? Object.keys(req.user) : [],
        });
        return null;
      }
      
      if (currentUserId && typeof currentUserId === 'object' && currentUserId.toString) {
        currentUserId = currentUserId.toString();
      } else {
        currentUserId = String(currentUserId || '');
      }
      
      // Trim whitespace and compare
      conversationUserId = conversationUserId.trim();
      currentUserId = currentUserId.trim();
      
      logger.info('[SolidStorage] Comparing user IDs in getConvoFromSolid', {
        conversationId,
        conversationUserIdRaw: conversationData.user,
        conversationUserIdString: conversationUserId,
        currentUserIdRaw: req.user.id,
        currentUserIdString: currentUserId,
        userIdType: typeof req.user.id,
        conversationUserIdType: typeof conversationData.user,
        userIdsMatch: conversationUserId === currentUserId,
        conversationUserIdLength: conversationUserId.length,
        currentUserIdLength: currentUserId.length,
        areEqual: conversationUserId === currentUserId,
        conversationUserIdCharCodes: conversationUserId.split('').map(c => c.charCodeAt(0)),
        currentUserIdCharCodes: currentUserId.split('').map(c => c.charCodeAt(0)),
      });
      
      if (conversationUserId !== currentUserId) {
        logger.error('[SolidStorage] Conversation belongs to different user - RETURNING NULL', {
          conversationId,
          conversationUserIdRaw: conversationData.user,
          conversationUserIdString: conversationUserId,
          currentUserIdRaw: req.user.id,
          currentUserIdString: currentUserId,
          userIdType: typeof req.user.id,
          conversationUserIdType: typeof conversationData.user,
          conversationUserIdLength: conversationUserId.length,
          currentUserIdLength: currentUserId.length,
          areEqual: conversationUserId === currentUserId,
          conversationUserIdCharCodes: conversationUserId.split('').map(c => c.charCodeAt(0)),
          currentUserIdCharCodes: currentUserId.split('').map(c => c.charCodeAt(0)),
        });
        return null;
      }

      // If model or endpoint are missing, try to extract them from messages
      if (!conversationData.model || !conversationData.endpoint) {
        try {
          const messages = await getMessagesFromSolid(req, conversationId);
          
          // Find the first message with a model (usually the AI response)
          const messageWithModel = messages.find(msg => msg.model && msg.endpoint);
          
          if (messageWithModel) {
            if (!conversationData.model && messageWithModel.model) {
              logger.info('[SolidStorage] Extracting model from messages', {
                conversationId,
                extractedModel: messageWithModel.model,
              });
              conversationData.model = messageWithModel.model;
            }
            
            if (!conversationData.endpoint && messageWithModel.endpoint) {
              logger.info('[SolidStorage] Extracting endpoint from messages', {
                conversationId,
                extractedEndpoint: messageWithModel.endpoint,
              });
              conversationData.endpoint = messageWithModel.endpoint;
            }
          }
        } catch (error) {
          // If we can't get messages, log but don't fail
          logger.warn('[SolidStorage] Could not extract model/endpoint from messages', {
            conversationId,
            error: error.message,
          });
        }
      }

      logger.info('[SolidStorage] Conversation retrieved successfully', {
        conversationId,
        title: conversationData.title,
        hasEndpoint: !!conversationData.endpoint,
        hasModel: !!conversationData.model,
        messageCount: conversationData.messages?.length || 0,
        userId: conversationData.user,
        expectedUserId: req.user.id,
      });

      return conversationData;
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        logger.info('[SolidStorage] Conversation not found', {
          conversationId,
        });
        return null;
      }
      throw error;
    }
  } catch (error) {
    logger.error('[SolidStorage] Error getting conversation from Solid Pod', {
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get conversations with cursor-based pagination from Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Object} options - Query options
 * @param {string} [options.cursor] - Base64-encoded cursor for pagination
 * @param {number} [options.limit=25] - Maximum number of conversations to return
 * @param {boolean} [options.isArchived=false] - Filter by archived status
 * @param {Array<string>} [options.tags] - Filter by tags
 * @param {string} [options.search] - Search query (in-memory text matching)
 * @param {string} [options.sortBy='updatedAt'] - Sort field: 'title', 'createdAt', or 'updatedAt'
 * @param {string} [options.sortDirection='desc'] - Sort direction: 'asc' or 'desc'
 * @returns {Promise<{conversations: Array, nextCursor: string|null}>} Conversations and next cursor
 */
async function getConvosByCursorFromSolid(req, options = {}) {
  try {
    const {
      cursor,
      limit = 25,
      isArchived = false,
      tags,
      search,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
    } = options;

    logger.info('[SolidStorage] Getting conversations with cursor from Solid Pod', {
      cursor: cursor ? 'present' : 'none',
      limit,
      isArchived,
      tags: tags?.length || 0,
      search: search || 'none',
      sortBy,
      sortDirection,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    // Validate sortBy field
    const validSortFields = ['title', 'createdAt', 'updatedAt'];
    if (!validSortFields.includes(sortBy)) {
      throw new Error(
        `Invalid sortBy field: ${sortBy}. Must be one of ${validSortFields.join(', ')}`,
      );
    }

    const finalSortBy = sortBy;
    const finalSortDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    // TODO: Allow user to select their storage (can happen after the initial PR).
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get conversations container path
    const conversationsContainerPath = `${getBaseStoragePath(podUrl)}conversations/`;

    logger.debug('[SolidStorage] Reading conversations container', {
      conversationsContainerPath,
    });

    // Get all conversation files
    // Solid Pods return Turtle (RDF) format with ldp:contains predicates
    let containerContents = [];
    try {
      // Try to get container contents using direct HTTP request
      const response = await authenticatedFetch(conversationsContainerPath, {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle, application/ld+json, */*',
        },
      });
      
      if (response.status === 404) {
        // Container doesn't exist, return empty result
        logger.info('[SolidStorage] Conversations container does not exist (404), returning empty array', {
          conversationsContainerPath,
        });
        return { conversations: [], nextCursor: null };
      }
      
      if (!response.ok) {
        throw new Error(`Failed to get container contents: ${response.status} ${response.statusText}`);
      }
      
      // Parse the response as text (Solid containers return Turtle format)
      // Format: ldp:contains <item1>, <item2>, <item3>.
      const text = await response.text();
      
      // Parse Turtle format to extract all items from ldp:contains
      // Handle both single and comma-separated items: ldp:contains <item1>, <item2>.
      // TODO: Use RDF object mapper to parse this.
      const ldpContainsPattern = /ldp:contains\s+((?:<[^>]+>(?:\s*,\s*<[^>]+>)*))/g;
      const allItems = [];
      let match;
      
      while ((match = ldpContainsPattern.exec(text)) !== null) {
        // Extract all URLs from the matched group (handles comma-separated items)
        const itemsString = match[1];
        const itemPattern = /<([^>]+)>/g;
        let itemMatch;
        while ((itemMatch = itemPattern.exec(itemsString)) !== null) {
          const itemUrl = itemMatch[1];
          // Convert relative URLs to absolute URLs
          const absoluteUrl = itemUrl.startsWith('http') 
            ? itemUrl 
            : new URL(itemUrl, conversationsContainerPath).href;
          allItems.push({ url: absoluteUrl });
        }
      }
      
      containerContents = allItems;
      
      logger.debug('[SolidStorage] Container contents retrieved', {
        conversationsContainerPath,
        itemCount: containerContents.length,
        items: containerContents.map(c => c.url),
      });
    } catch (error) {
      // Log full error details for debugging
      const errorMessage = error?.message || String(error) || 'Unknown error';
      const errorStatus = error?.status || error?.statusCode || error?.response?.status || 'no status';
      const errorName = error?.name || 'Unknown';
      
      logger.warn('[SolidStorage] Error getting container contents', {
        conversationsContainerPath,
        errorMessage,
        errorName,
        errorStatus,
        errorType: typeof error,
        errorString: String(error),
        errorKeys: error ? Object.keys(error) : [],
        hasResponse: !!error?.response,
        responseStatus: error?.response?.status,
        responseStatusText: error?.response?.statusText,
      });
      
      // Check if error is a 404 (container doesn't exist)
      const isNotFound = 
        errorStatus === 404 || 
        errorStatus === '404' ||
        errorMessage?.includes('404') || 
        errorMessage?.includes('Not Found') ||
        errorMessage?.toLowerCase().includes('not found') ||
        errorMessage?.toLowerCase().includes('404');
      
      if (isNotFound) {
        // Container doesn't exist, return empty result (this is expected for new users)
        logger.info('[SolidStorage] Conversations container does not exist (404), returning empty array', {
          conversationsContainerPath,
          errorStatus,
          errorMessage,
        });
        return { conversations: [], nextCursor: null };
      }
      
      // Log unexpected errors but don't throw - return empty array instead
      // This prevents fallback to MongoDB when user is logged in via "Continue with Solid"
      logger.warn('[SolidStorage] Unexpected error getting container contents, returning empty array', {
        conversationsContainerPath,
        errorMessage,
        errorName,
        errorStatus,
        errorStack: error?.stack,
      });
      
      // Return empty array instead of throwing to avoid MongoDB fallback
      return { conversations: [], nextCursor: null };
    }

    // Filter for JSON files only
    const conversationFiles = Array.from(containerContents).filter((item) => {
      const url = item.url || '';
      return url.endsWith('.json') && !url.endsWith('.meta.json');
    });

    logger.debug('[SolidStorage] Found conversation files', {
      fileCount: conversationFiles.length,
    });

    // Read all conversation files
    const allConversations = [];
    for (const fileInfo of conversationFiles) {
      try {
        const fileUrl = fileInfo.url;
        const file = await getFile(fileUrl, { fetch: authenticatedFetch });
        const fileText = await file.text();
        const conversationData = JSON.parse(fileText);

        // Validate that this conversation belongs to the current user
        if (conversationData.user !== req.user.id) {
          continue;
        }

        allConversations.push(conversationData);
      } catch (error) {
        logger.error('[SolidStorage] Error reading conversation file', {
          fileUrl: fileInfo.url,
          error: error.message,
        });
        // Continue with other files even if one fails
      }
    }

    logger.debug('[SolidStorage] All conversations loaded', {
      totalCount: allConversations.length,
    });

    // Apply filters
    let filtered = allConversations;

    // Filter by archived status
    if (isArchived) {
      filtered = filtered.filter((convo) => convo.isArchived === true);
    } else {
      filtered = filtered.filter(
        (convo) => !convo.isArchived || convo.isArchived === false,
      );
    }

    // Filter by tags
    if (Array.isArray(tags) && tags.length > 0) {
      filtered = filtered.filter((convo) => {
        const convoTags = convo.tags || [];
        return tags.some((tag) => convoTags.includes(tag));
      });
    }

    // Filter out expired conversations
    filtered = filtered.filter((convo) => {
      if (!convo.expiredAt) {
        return true;
      }
      const expiredDate = new Date(convo.expiredAt);
      return expiredDate > new Date();
    });

    // Apply search (in-memory text matching)
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter((convo) => {
        const title = (convo.title || '').toLowerCase();
        return title.includes(searchLower);
      });
    }

    // Apply cursor filter
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        const { primary, secondary } = decoded;
        const primaryValue = finalSortBy === 'title' ? primary : new Date(primary);
        const secondaryValue = new Date(secondary);
        const op = finalSortDirection === 'asc' ? 'gt' : 'lt';

        filtered = filtered.filter((convo) => {
          const convoPrimary = finalSortBy === 'title' ? convo[finalSortBy] : new Date(convo[finalSortBy]);
          const convoSecondary = new Date(convo.updatedAt);

          if (op === 'gt') {
            return (
              convoPrimary > primaryValue ||
              (convoPrimary.getTime && convoPrimary.getTime() === primaryValue.getTime() &&
                convoSecondary > secondaryValue)
            );
          } else {
            return (
              convoPrimary < primaryValue ||
              (convoPrimary.getTime && convoPrimary.getTime() === primaryValue.getTime() &&
                convoSecondary < secondaryValue)
            );
          }
        });
      } catch (err) {
        logger.warn('[SolidStorage] Invalid cursor format, starting from beginning', {
          error: err.message,
        });
      }
    }

    // Sort conversations
    const sortOrder = finalSortDirection === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      let aPrimary = a[finalSortBy];
      let bPrimary = b[finalSortBy];

      if (finalSortBy !== 'title') {
        aPrimary = new Date(aPrimary || 0);
        bPrimary = new Date(bPrimary || 0);
      } else {
        aPrimary = (aPrimary || '').toLowerCase();
        bPrimary = (bPrimary || '').toLowerCase();
      }

      if (aPrimary < bPrimary) {
        return -1 * sortOrder;
      }
      if (aPrimary > bPrimary) {
        return 1 * sortOrder;
      }

      // If primary values are equal, sort by updatedAt
      const aSecondary = new Date(a.updatedAt || 0);
      const bSecondary = new Date(b.updatedAt || 0);
      if (aSecondary < bSecondary) {
        return -1 * sortOrder;
      }
      if (aSecondary > bSecondary) {
        return 1 * sortOrder;
      }
      return 0;
    });

    // Apply limit + 1 to detect if there are more results
    const limited = filtered.slice(0, limit + 1);

    // Extract next cursor if there are more results
    let nextCursor = null;
    if (limited.length > limit) {
      limited.pop(); // Remove extra item used to detect next page
      const lastReturned = limited[limited.length - 1];
      const primaryValue = lastReturned[finalSortBy];
      const primaryStr = finalSortBy === 'title' ? primaryValue : new Date(primaryValue).toISOString();
      const secondaryStr = new Date(lastReturned.updatedAt).toISOString();
      const composite = { primary: primaryStr, secondary: secondaryStr };
      nextCursor = Buffer.from(JSON.stringify(composite)).toString('base64');
    }

    // Select only required fields (matching MongoDB behavior)
    const conversations = limited.map((convo) => ({
      conversationId: convo.conversationId,
      endpoint: convo.endpoint,
      title: convo.title,
      createdAt: convo.createdAt,
      updatedAt: convo.updatedAt,
      user: convo.user,
      model: convo.model,
      agent_id: convo.agent_id,
      assistant_id: convo.assistant_id,
      spec: convo.spec,
      iconURL: convo.iconURL,
      isArchived: convo.isArchived || false,
    }));

    logger.info('[SolidStorage] Conversations retrieved successfully', {
      returnedCount: conversations.length,
      nextCursor: nextCursor ? 'present' : 'none',
    });

    return { conversations, nextCursor };
  } catch (error) {
    logger.error('[SolidStorage] Error getting conversations from Solid Pod', {
      errorMessage: error.message,
      errorName: error.name,
      errorStatus: error.status,
      errorCode: error.code,
      stack: error.stack,
      userId: req.user?.id,
      openidId: req.user?.openidId,
    });
    throw error;
  }
}

/**
 * Delete conversations from Solid Pod
 * 
 * @param {Object} req - Express request object
 * @param {Array<string>} conversationIds - Array of conversation IDs to delete
 * @returns {Promise<number>} Number of conversations deleted
 */
async function deleteConvosFromSolid(req, conversationIds) {
  try {
    logger.info('[SolidStorage] Deleting conversations from Solid Pod', {
      conversationIds,
      count: conversationIds?.length || 0,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      logger.warn('[SolidStorage] No conversation IDs provided for deletion');
      return 0;
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    let deletedCount = 0;

    // Delete each conversation and its associated messages
    for (const conversationId of conversationIds) {
      try {
        // Get conversation file path
        const conversationPath = getConversationPath(podUrl, conversationId);

        // Verify conversation belongs to user before deleting
        try {
          const conversation = await getConvoFromSolid(req, conversationId);
          if (!conversation) {
            logger.warn('[SolidStorage] Conversation not found or does not belong to user', {
              conversationId,
            });
            continue;
          }
        } catch (error) {
          logger.warn('[SolidStorage] Error verifying conversation ownership, skipping', {
            conversationId,
            error: error.message,
          });
          continue;
        }

        // Delete all messages for this conversation
        try {
          const messagesDeleted = await deleteMessagesFromSolid(req, {
            conversationId,
          });
          
          logger.info('[SolidStorage] Messages deleted for conversation', {
            conversationId,
            messagesDeleted,
          });
          
          if (messagesDeleted === 0) {
            logger.warn('[SolidStorage] No messages were deleted - this may indicate an issue', {
              conversationId,
            });
          }
          
          // Also try to delete the messages container directory if it's empty
          // This is optional - some Solid servers handle empty containers automatically
          try {
            const messagesContainerPath = getMessagesContainerPath(podUrl, conversationId);
            // Try to delete the container - this may fail if it's not empty or not allowed
            // We'll just log and continue if it fails
            try {
              await deleteFile(messagesContainerPath, { fetch: authenticatedFetch });
              logger.debug('[SolidStorage] Messages container directory deleted', {
                conversationId,
                messagesContainerPath,
              });
            } catch (containerError) {
              // It's okay if we can't delete the container - the files are already deleted
              logger.debug('[SolidStorage] Could not delete messages container (may not be empty or not allowed)', {
                conversationId,
                messagesContainerPath,
                error: containerError.message,
              });
            }
          } catch (containerPathError) {
            // Ignore errors when trying to delete the container
            logger.debug('[SolidStorage] Error getting messages container path for deletion', {
              conversationId,
              error: containerPathError.message,
            });
          }
        } catch (error) {
          logger.error('[SolidStorage] Error deleting messages for conversation - THIS IS A PROBLEM', {
            conversationId,
            error: error.message,
            stack: error.stack,
          });
          // Continue with conversation deletion even if messages fail
        }

        // Delete the conversation file
        try {
          await deleteFile(conversationPath, { fetch: authenticatedFetch });
          deletedCount++;
          logger.info('[SolidStorage] Conversation deleted successfully', {
            conversationId,
            conversationPath,
          });
        } catch (error) {
          if (error.status === 404 || error.message?.includes('404')) {
            // File already doesn't exist, count it as deleted
            deletedCount++;
            logger.debug('[SolidStorage] Conversation file already deleted', {
              conversationId,
            });
          } else {
            logger.error('[SolidStorage] Error deleting conversation file', {
              conversationId,
              conversationPath,
              error: error.message,
            });
            // Continue with other conversations even if one fails
          }
        }
      } catch (error) {
        logger.error('[SolidStorage] Error processing conversation deletion', {
          conversationId,
          error: error.message,
        });
        // Continue with other conversations even if one fails
      }
    }

    logger.info('[SolidStorage] Conversations deleted successfully', {
      requestedCount: conversationIds.length,
      deletedCount,
    });

    return deletedCount;
  } catch (error) {
    logger.error('[SolidStorage] Error deleting conversations from Solid Pod', {
      conversationIds,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Gets the ACL URL for a resource
 * @param {string} resourceUrl - The resource URL
 * @param {Function} fetchFn - Authenticated fetch function
 * @returns {Promise<string>} The ACL URL
 */
async function getAclUrl(resourceUrl, fetchFn) {
  try {
    const response = await fetchFn(resourceUrl, {
      method: 'HEAD',
      headers: {
        Accept: '*/*',
      },
    });
    // Even if we get 403, we can still try to get the Link header
    const linkHeader = response.headers.get('Link');
    if (linkHeader) {
      const aclMatch = linkHeader.match(/<([^>]+)>;\s*rel=["']acl["']/i);
      if (aclMatch && aclMatch[1]) {
        return aclMatch[1];
      }
    }
  } catch (error) {
    // If HEAD fails (including 403), fall back to appending .acl
    logger.debug('[SolidStorage] Failed to discover ACL URL via Link header, using fallback', {
      resourceUrl,
      error: error.message,
      errorStatus: error.status,
    });
  }
  // Default: append .acl to the resource URL
  if (resourceUrl.endsWith('/')) {
    return resourceUrl + '.acl';
  }
  return resourceUrl + '.acl';
}

/**
 * Fetches an existing ACL or returns null if it doesn't exist
 * @param {string} aclUrl - The ACL URL
 * @param {Function} fetchFn - Authenticated fetch function
 * @returns {Promise<string|null>} The ACL Turtle content or null
 */
async function fetchAcl(aclUrl, fetchFn) {
  try {
    const response = await fetchFn(aclUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/turtle',
      },
    });
    if (!response.ok) {
      // Treat 404 and 403 as "no ACL exists" - we'll create a new one
      if (response.status === 404 || response.status === 403) {
        return null;
      }
      throw new Error(`Failed to fetch ACL: ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    // Treat 404 and 403 as "no ACL exists"
    if (error.status === 404 || error.status === 403 || error.message?.includes('404') || error.message?.includes('403')) {
      return null;
    }
    throw error;
  }
}

/**
 * Checks if public access already exists in ACL Turtle content
 * @param {string} aclTurtle - The ACL Turtle content
 * @returns {boolean} True if public access exists
 */
function hasPublicAccessInAcl(aclTurtle) {
  return aclTurtle.includes('acl:agentClass') && aclTurtle.includes('foaf:Agent');
}

/**
 * Creates a new ACL with public read access and owner permissions
 * @param {string} resourceUrl - The resource URL
 * @param {string} aclUrl - The ACL URL
 * @param {boolean} isContainer - Whether this is a container (needs acl:default)
 * @param {string} [ownerWebId] - Optional owner WebID to grant full permissions
 * @returns {Promise<string>} The ACL Turtle content
 */
async function createPublicAcl(resourceUrl, aclUrl, isContainer = false, ownerWebId = null) {
  const { namedNode, blankNode, quad } = DataFactory;
  const quads = [];
  
  // If owner WebID is provided, create Authorization for owner with full permissions
  if (ownerWebId) {
    const ownerAuthNode = blankNode('ownerAuth');
    
    // Authorization: type
    quads.push(quad(ownerAuthNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
    
    // Authorization: agent (the owner)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}agent`), namedNode(ownerWebId)));
    
    // Authorization: accessTo (the resource)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
    
    // If this is a container, also add default access for resources within it
    if (isContainer) {
      quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}default`), namedNode(resourceUrl)));
    }
    
    // Authorization: mode (Write, Append, Control for owner)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Write`)));
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Append`)));
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Control`)));
  }
  
  // Create Authorization for public access
  const authNode = blankNode('publicAuth');
  
  // Authorization: type
  quads.push(quad(authNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
  
  // Authorization: agentClass (foaf:Agent = anyone/public)
  quads.push(quad(authNode, namedNode(`${ACL_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));
  
  // Authorization: accessTo (the resource)
  quads.push(quad(authNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
  
  // If this is a container, also add default access for resources within it
  if (isContainer) {
    quads.push(quad(authNode, namedNode(`${ACL_NS}default`), namedNode(resourceUrl)));
  }
  
  // Authorization: mode (Read access)
  quads.push(quad(authNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Read`)));
  
  // Convert quads to Turtle using N3 Writer
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: { acl: ACL_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Updates an existing ACL by adding public read access and ensuring owner permissions
 * @param {string} existingTurtle - The existing ACL Turtle content
 * @param {string} aclUrl - The ACL URL
 * @param {string} resourceUrl - The resource URL
 * @param {boolean} isContainer - Whether this is a container (needs acl:default)
 * @param {string} [ownerWebId] - Optional owner WebID to ensure full permissions
 * @returns {Promise<string>} The updated ACL Turtle content
 */
async function updateAclWithPublicAccess(existingTurtle, aclUrl, resourceUrl, isContainer = false, ownerWebId = null) {
  const { namedNode, blankNode, quad } = DataFactory;
  const quads = [];
  
  // Check if owner permissions exist in the existing ACL
  const hasOwnerPermissions = ownerWebId && existingTurtle.includes(ownerWebId);
  
  // If owner WebID is provided and owner permissions don't exist, add them
  if (ownerWebId && !hasOwnerPermissions) {
    const ownerAuthNode = blankNode('ownerAuth');
    
    // Authorization: type
    quads.push(quad(ownerAuthNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
    
    // Authorization: agent (the owner)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}agent`), namedNode(ownerWebId)));
    
    // Authorization: accessTo (the resource)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
    
    // If this is a container, also add default access for resources within it
    if (isContainer) {
      quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}default`), namedNode(resourceUrl)));
    }
    
    // Authorization: mode (Write, Append, Control for owner)
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Write`)));
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Append`)));
    quads.push(quad(ownerAuthNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Control`)));
  }
  
  // Check if public access already exists
  if (hasPublicAccessInAcl(existingTurtle)) {
    // If we added owner permissions, combine them with existing ACL
    if (quads.length > 0) {
      const newTurtle = await new Promise((resolve, reject) => {
        const writer = new Writer({ prefixes: { acl: ACL_NS, rdf: RDF_NS, foaf: FOAF_NS } });
        quads.forEach((q) => writer.addQuad(q));
        writer.end((error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
      return existingTurtle + '\n' + newTurtle;
    }
    return existingTurtle; // Public access already exists, no changes needed
  }
  
  // Create Authorization for public access
  const authNode = blankNode('publicAuth');
  quads.push(quad(authNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
  quads.push(quad(authNode, namedNode(`${ACL_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));
  quads.push(quad(authNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
  
  // If this is a container, also add default access for resources within it
  if (isContainer) {
    quads.push(quad(authNode, namedNode(`${ACL_NS}default`), namedNode(resourceUrl)));
  }
  
  quads.push(quad(authNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Read`)));
  
  // Convert new quads to Turtle
  const newTurtle = await new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: { acl: ACL_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  
  // Combine existing and new Turtle
  return existingTurtle + '\n' + newTurtle;
}

/**
 * Grants public read access to a Solid resource using manual ACL Turtle approach
 * @param {string} resourceUrl - The resource URL
 * @param {Function} fetchFn - Authenticated fetch function
 * @param {boolean} isContainer - Whether this is a container (needs acl:default)
 * @param {string} [ownerWebId] - Optional owner WebID to grant full permissions
 * @returns {Promise<void>}
 */
async function grantPublicReadAccess(resourceUrl, fetchFn, isContainer = false, ownerWebId = null) {
  // Get ACL URL - if HEAD fails with 403, we'll still try to create the ACL file
  let aclUrl;
  try {
    aclUrl = await getAclUrl(resourceUrl, fetchFn);
  } catch (error) {
    // If HEAD fails, fall back to appending .acl
    logger.debug('[SolidStorage] Failed to get ACL URL via HEAD, using fallback', {
      resourceUrl,
      error: error.message,
    });
    if (resourceUrl.endsWith('/')) {
      aclUrl = resourceUrl + '.acl';
    } else {
      aclUrl = resourceUrl + '.acl';
    }
  }
  
  // Fetch existing ACL or create new one
  // If we get 403, treat it as "no ACL exists" and create a new one
  let existingTurtle = null;
  try {
    existingTurtle = await fetchAcl(aclUrl, fetchFn);
  } catch (error) {
    // If fetch fails (including 403), treat as no ACL exists
    logger.debug('[SolidStorage] Failed to fetch existing ACL, will create new one', {
      aclUrl,
      error: error.message,
    });
    existingTurtle = null;
  }
  
  let turtle;
  
  if (existingTurtle) {
    // Update existing ACL with public access and ensure owner permissions
    turtle = await updateAclWithPublicAccess(existingTurtle, aclUrl, resourceUrl, isContainer, ownerWebId);
  } else {
    // Create new ACL with public access and owner permissions
    turtle = await createPublicAcl(resourceUrl, aclUrl, isContainer, ownerWebId);
  }
  
  // Save ACL - even if we got 403 before, we should be able to PUT the ACL file
  const response = await fetchFn(aclUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
    },
    body: turtle,
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to save ACL: ${response.status} ${response.statusText} - ${errorText}`);
  }
  
  logger.debug('[SolidStorage] ACL file created/updated successfully', {
    aclUrl,
    resourceUrl,
    isContainer,
    hasOwnerPermissions: !!ownerWebId,
  });
}

/**
 * Removes public read access from a Solid resource using manual ACL Turtle approach
 * @param {string} resourceUrl - The resource URL
 * @param {Function} fetchFn - Authenticated fetch function
 * @returns {Promise<void>}
 */
async function removePublicReadAccess(resourceUrl, fetchFn) {
  const aclUrl = await getAclUrl(resourceUrl, fetchFn);
  
  // Fetch existing ACL
  const existingTurtle = await fetchAcl(aclUrl, fetchFn);
  
  if (!existingTurtle) {
    // No ACL exists, nothing to remove
    return;
  }
  
  // Check if public access exists
  if (!hasPublicAccessInAcl(existingTurtle)) {
    // Public access doesn't exist, nothing to remove
    return;
  }
  
  // Remove public access lines from Turtle
  // This is a simple approach - remove lines containing foaf:Agent
  const lines = existingTurtle.split('\n');
  const filteredLines = [];
  let skipNext = false;
  let inPublicAuth = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect start of public authorization (blank node with foaf:Agent)
    if (line.includes('foaf:Agent') && (line.includes('acl:agentClass') || line.includes('acl:Authorization'))) {
      inPublicAuth = true;
      skipNext = true;
      continue;
    }
    
    // Skip lines that are part of the public authorization
    if (inPublicAuth) {
      if (line.trim().endsWith('.') && !line.includes('foaf:Agent')) {
        inPublicAuth = false;
        skipNext = false;
      }
      continue;
    }
    
    // Skip lines that are clearly part of public auth block
    if (skipNext && (line.includes('acl:accessTo') || line.includes('acl:mode') || line.includes('acl:Read'))) {
      if (line.trim().endsWith('.')) {
        skipNext = false;
      }
      continue;
    }
    
    skipNext = false;
    filteredLines.push(line);
  }
  
  const updatedTurtle = filteredLines.join('\n');
  
  // Save updated ACL (or delete if empty)
  if (updatedTurtle.trim().length === 0) {
    // Delete ACL file if it's empty
    try {
      await fetchFn(aclUrl, {
        method: 'DELETE',
      });
    } catch (error) {
      logger.warn('[SolidStorage] Error deleting empty ACL', {
        aclUrl,
        error: error.message,
      });
    }
  } else {
    const response = await fetchFn(aclUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
      },
      body: updatedTurtle,
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Failed to save ACL: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }
}

/**
 * Set public read access for a shared conversation and its messages
 * This makes the conversation and all its messages publicly accessible
 * 
 * @param {Object} req - Express request object
 * @param {string} conversationId - The conversation ID to share
 * @returns {Promise<void>}
 */
async function setPublicAccessForShare(req, conversationId) {
  try {
    logger.info('[SolidStorage] Setting public access for shared conversation', {
      conversationId,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get conversation file path
    const conversationPath = getConversationPath(podUrl, conversationId);

    // Verify conversation belongs to user before sharing
    try {
      const conversation = await getConvoFromSolid(req, conversationId);
      if (!conversation) {
        throw new Error('Conversation not found or does not belong to user');
      }
    } catch (error) {
      logger.error('[SolidStorage] Error verifying conversation ownership before sharing', {
        conversationId,
        error: error.message,
      });
      throw error;
    }

    // Get all messages for this conversation
    const messages = await getMessagesFromSolid(req, conversationId);

    if (messages.length === 0) {
      logger.warn('[SolidStorage] No messages found for conversation to share', {
        conversationId,
      });
      throw new Error('No messages to share');
    }

    // Get owner WebID for preserving owner permissions
    const ownerWebId = req.user.openidId;

    // Set public read access on conversation file using manual Turtle approach
    try {
      logger.debug('[SolidStorage] Setting public access on conversation file', {
        conversationPath,
        conversationId,
        ownerWebId,
      });
      await grantPublicReadAccess(conversationPath, authenticatedFetch, false, ownerWebId);
      logger.info('[SolidStorage] Public read access set on conversation file', {
        conversationPath,
        conversationId,
      });
    } catch (error) {
      logger.error('[SolidStorage] Error setting public access on conversation file', {
        conversationPath,
        conversationId,
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        stack: error.stack,
      });
      throw error;
    }

    // Set public read access on messages container using manual Turtle approach
    // IMPORTANT: For containers, we need to set acl:default so files within inherit access
    // IMPORTANT: We must preserve owner permissions so the owner can still add messages
    const messagesContainerPath = getMessagesContainerPath(podUrl, conversationId);
    try {
      
      await grantPublicReadAccess(messagesContainerPath, authenticatedFetch, true, ownerWebId); // isContainer=true, ownerWebId
      logger.info('[SolidStorage] Public read access set on messages container (with default)', {
        messagesContainerPath,
        conversationId,
      });
    } catch (error) {
      logger.error('[SolidStorage] Error setting public access on messages container', {
        messagesContainerPath,
        conversationId,
        error: error.message,
        stack: error.stack,
      });
      // Continue with message files even if container access fails
    }

    // Set public read access on each message file using manual Turtle approach
    let messagesShared = 0;
    for (const message of messages) {
      try {
        const messagePath = getMessagePath(podUrl, conversationId, message.messageId);
      
        try {
          await grantPublicReadAccess(messagePath, authenticatedFetch, false, ownerWebId);
          messagesShared++;
        } catch (grantError) {
          // If grantPublicReadAccess fails, try to create ACL file directly
          // This handles cases where we get 403 on HEAD/GET but can still PUT the ACL
          logger.debug('[SolidStorage] grantPublicReadAccess failed, trying direct ACL creation', {
            messagePath,
            messageId: message.messageId,
            error: grantError.message,
          });
          
          const aclUrl = messagePath.endsWith('/') ? messagePath + '.acl' : messagePath + '.acl';
          const turtle = await createPublicAcl(messagePath, aclUrl, false, ownerWebId);
          
          const response = await authenticatedFetch(aclUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': 'text/turtle',
            },
            body: turtle,
          });
          
          if (response.ok) {
            logger.info('[SolidStorage] ACL file created directly for message file', {
              messagePath,
              messageId: message.messageId,
            });
            messagesShared++;
          } else {
            const errorText = await response.text().catch(() => response.statusText);
            throw new Error(`Failed to create ACL directly: ${response.status} ${response.statusText} - ${errorText}`);
          }
        }
      } catch (error) {
        logger.error('[SolidStorage] Error setting public access on message file', {
          messageId: message.messageId,
          conversationId,
          error: error.message,
          errorStatus: error.status,
        });
        // Continue with other messages even if one fails
      }
    }

    logger.info('[SolidStorage] Public access set for shared conversation', {
      conversationId,
      messagesShared,
      totalMessages: messages.length,
    });
  } catch (error) {
    logger.error('[SolidStorage] Error setting public access for share', {
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Remove public read access for a shared conversation and its messages
 * This unshares the conversation and makes it private again
 * 
 * @param {Object} req - Express request object
 * @param {string} conversationId - The conversation ID to unshare
 * @returns {Promise<void>}
 */
async function removePublicAccessForShare(req, conversationId) {
  try {
    logger.info('[SolidStorage] Removing public access for shared conversation', {
      conversationId,
    });

    // Validate required fields
    if (!req?.user?.id) {
      throw new Error('User not authenticated');
    }

    if (!conversationId) {
      throw new Error('conversationId is required');
    }

    // Get authenticated fetch and Pod URL
    const authenticatedFetch = await getSolidFetch(req);
    const podUrl = await getPodUrl(req.user.openidId, authenticatedFetch);

    // Get conversation file path
    const conversationPath = getConversationPath(podUrl, conversationId);

    // Remove public read access from conversation file using manual Turtle approach
    try {
      logger.debug('[SolidStorage] Removing public access from conversation file', {
        conversationPath,
        conversationId,
      });
      await removePublicReadAccess(conversationPath, authenticatedFetch);
      logger.info('[SolidStorage] Public read access removed from conversation file', {
        conversationPath,
        conversationId,
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        logger.debug('[SolidStorage] Conversation file not found when removing public access', {
          conversationPath,
          conversationId,
        });
      } else {
        logger.error('[SolidStorage] Error removing public access from conversation file', {
          conversationPath,
          conversationId,
          error: error.message,
          stack: error.stack,
        });
        // Continue with other files even if one fails
      }
    }

    // Remove public read access from messages container using manual Turtle approach
    const messagesContainerPath = getMessagesContainerPath(podUrl, conversationId);
    try {
      logger.debug('[SolidStorage] Removing public access from messages container', {
        messagesContainerPath,
        conversationId,
      });
      await removePublicReadAccess(messagesContainerPath, authenticatedFetch);
      logger.info('[SolidStorage] Public read access removed from messages container', {
        messagesContainerPath,
        conversationId,
      });
    } catch (error) {
      if (error.status === 404 || error.message?.includes('404')) {
        logger.debug('[SolidStorage] Messages container not found when removing public access', {
          messagesContainerPath,
          conversationId,
        });
      } else {
        logger.error('[SolidStorage] Error removing public access from messages container', {
          messagesContainerPath,
          conversationId,
          error: error.message,
        });
        // Continue with message files even if container access fails
      }
    }

    // Try to get messages (they might not exist if conversation was deleted)
    let messages = [];
    try {
      messages = await getMessagesFromSolid(req, conversationId);
    } catch (error) {
      logger.debug('[SolidStorage] Could not fetch messages when removing public access (conversation may be deleted)', {
        conversationId,
        error: error.message,
      });
    }

    // Remove public read access from each message file using manual Turtle approach
    let messagesUnshared = 0;
    for (const message of messages) {
      try {
        const messagePath = getMessagePath(podUrl, conversationId, message.messageId);
        logger.debug('[SolidStorage] Removing public access from message file', {
          messagePath,
          messageId: message.messageId,
        });
        await removePublicReadAccess(messagePath, authenticatedFetch);
        messagesUnshared++;
      } catch (error) {
        if (error.status === 404 || error.message?.includes('404')) {
          logger.debug('[SolidStorage] Message file not found when removing public access', {
            messageId: message.messageId,
            conversationId,
          });
          messagesUnshared++; // Count as unshared if already deleted
        } else {
          logger.error('[SolidStorage] Error removing public access from message file', {
            messageId: message.messageId,
            conversationId,
            error: error.message,
          });
          // Continue with other messages even if one fails
        }
      }
    }

    logger.info('[SolidStorage] Public access removed for shared conversation', {
      conversationId,
      messagesUnshared,
      totalMessages: messages.length,
    });
  } catch (error) {
    logger.error('[SolidStorage] Error removing public access for share', {
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get shared messages from Solid Pod using public access (no authentication required)
 * 
 * @param {string} shareId - The share ID
 * @param {string} conversationId - The conversation ID (from SharedLink)
 * @param {string} podUrl - The Pod URL where the conversation is stored
 * @param {string} [targetMessageId] - Optional target message ID for branch sharing
 * @returns {Promise<Object|null>} Shared conversation with messages, or null if not found
 */
async function getSharedMessagesFromSolid(shareId, conversationId, podUrl, targetMessageId) {
  try {
    logger.info('[SolidStorage] Getting shared messages from Solid Pod', {
      shareId,
      conversationId,
      targetMessageId,
    });

    // Use unauthenticated fetch for public access
    const publicFetch = fetch;

    // Get conversation file path
    const conversationPath = getConversationPath(podUrl, conversationId);

    // Try to fetch conversation file with public access
    let conversationData;
    try {
      const file = await getFile(conversationPath, { fetch: publicFetch });
      const fileText = await file.text();
      conversationData = JSON.parse(fileText);
    } catch (error) {
      if (error.status === 404 || error.status === 403) {
        logger.warn('[SolidStorage] Conversation not found or not publicly accessible', {
          conversationId,
          shareId,
          error: error.message,
        });
        return null;
      }
      throw error;
    }

    // Get all messages for this conversation using public access
    const messagesContainerPath = getMessagesContainerPath(podUrl, conversationId);
    let messages = [];
    
    try {
      // Try to get container contents
      const containerResponse = await publicFetch(messagesContainerPath, {
        method: 'GET',
        headers: {
          'Accept': 'text/turtle',
        },
      });

      if (!containerResponse.ok) {
        if (containerResponse.status === 404 || containerResponse.status === 403) {
          logger.warn('[SolidStorage] Messages container not found or not publicly accessible', {
            conversationId,
            shareId,
            status: containerResponse.status,
          });
          return null;
        }
        throw new Error(`Failed to fetch messages container: ${containerResponse.status} ${containerResponse.statusText}`);
      }

      const containerText = await containerResponse.text();
      
      // Parse Turtle format to extract all items from ldp:contains
      const ldpContainsPattern = /ldp:contains\s+((?:<[^>]+>(?:\s*,\s*<[^>]+>)*))/g;
      const allItems = [];
      let match;
      
      while ((match = ldpContainsPattern.exec(containerText)) !== null) {
        const itemsString = match[1];
        const itemPattern = /<([^>]+)>/g;
        let itemMatch;
        while ((itemMatch = itemPattern.exec(itemsString)) !== null) {
          const itemUrl = itemMatch[1];
          const absoluteUrl = itemUrl.startsWith('http') 
            ? itemUrl 
            : new URL(itemUrl, messagesContainerPath).href;
          allItems.push({ url: absoluteUrl });
        }
      }

      // Filter for JSON files only
      const containerContents = allItems.filter((item) => {
        const url = item.url || '';
        return url.endsWith('.json') && !url.endsWith('.meta.json');
      });

      // Read all message files
      for (const item of containerContents) {
        const url = item.url || '';
        if (url.endsWith('.json') && !url.endsWith('.meta.json')) {
          try {
            const messageFile = await getFile(url, { fetch: publicFetch });
            const messageText = await messageFile.text();
            const messageData = JSON.parse(messageText);
            messages.push(messageData);
          } catch (error) {
            logger.warn('[SolidStorage] Error reading message file from public access', {
              messageUrl: url,
              error: error.message,
            });
            // Continue with other messages
          }
        }
      }

      // Sort messages by createdAt
      messages.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0);
        const dateB = new Date(b.createdAt || 0);
        return dateA - dateB;
      });
    } catch (error) {
      logger.error('[SolidStorage] Error fetching messages from Solid Pod', {
        conversationId,
        shareId,
        error: error.message,
        stack: error.stack,
      });
      return null;
    }

    // Filter messages by targetMessageId if present (branch sharing)
    let messagesToShare = messages;
    if (targetMessageId) {
      // Find the target message and get all messages up to it
      const targetIndex = messages.findIndex(msg => msg.messageId === targetMessageId);
      if (targetIndex >= 0) {
        messagesToShare = messages.slice(0, targetIndex + 1);
      } else {
        logger.warn('[SolidStorage] Target message not found in shared messages', {
          targetMessageId,
          conversationId,
          shareId,
        });
        messagesToShare = messages; // Return all messages if target not found
      }
    }

    if (messagesToShare.length === 0) {
      logger.warn('[SolidStorage] No messages to share', {
        conversationId,
        shareId,
      });
      return null;
    }

    // Return shared conversation data (anonymization will be done in the share methods)
    return {
      shareId,
      title: conversationData.title || 'Untitled',
      isPublic: true,
      createdAt: conversationData.createdAt,
      updatedAt: conversationData.updatedAt,
      conversationId: conversationId, // Will be anonymized later
      messages: messagesToShare, // Will be anonymized later
      targetMessageId,
    };
  } catch (error) {
    logger.error('[SolidStorage] Error getting shared messages from Solid Pod', {
      shareId,
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    return null;
  }
}

module.exports = {
  getSolidFetch,
  getPodUrl,
  getBaseStoragePath,
  getConversationPath,
  getMessagesContainerPath,
  getMessagePath,
  ensureContainerExists,
  ensureBaseStructure,
  saveMessageToSolid,
  getMessagesFromSolid,
  updateMessageInSolid,
  deleteMessagesFromSolid,
  saveConvoToSolid,
  getConvoFromSolid,
  getConvosByCursorFromSolid,
  deleteConvosFromSolid,
  setPublicAccessForShare,
  removePublicAccessForShare,
  getSharedMessagesFromSolid,
  // Re-export solid-client functions for convenience
  getFile,
  saveFileInContainer,
  overwriteFile,
  deleteFile,
};
