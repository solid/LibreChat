import { useCallback, useState, useEffect, useRef } from 'react';
import { useSolidAuth, useLdo } from '@ldo/solid-react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { logger } from '~/utils';

// Use any for LDO types since @ldo/solid types may not be directly importable
type Container = any;
type LeafUri = string;

const CONVERSATION_FOLDER = 'appData/llm-conversation-history/';
const ORDER_FILE = '_order.json';

interface OrderItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface StoredMessage {
  messageId: string;
  conversationId?: string;
  parentMessageId?: string;
  text: string;
  sender: string;
  isCreatedByUser: boolean;
  model?: string;
  endpoint?: string;
  createdAt?: string;
  updatedAt?: string;
  content?: unknown[];
  error?: boolean;
  finish_reason?: string;
}

interface ConversationFile {
  conversationId: string | null;
  title: string;
  messages: StoredMessage[]; // Full message objects
  endpoint?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown; // Allow other conversation fields
}

/**
 * Sanitize filename to be safe for file systems
 */
function sanitizeFileName(title: string): string {
  return title
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100) || 'untitled';
}

/**
 * Hook for managing Solid Pod storage of conversations
 */
export function useSolidStorage() {
  const { session, fetch: solidFetch } = useSolidAuth();
  const { getResource } = useLdo();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSessionReady, setIsSessionReady] = useState(false);

  const isSolidUser = session.isLoggedIn && !!session.webId;
  
  // Determine if session is ready (either logged in, or no Solid session expected)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    // If user is logged in, session is ready
    if (session.isLoggedIn && session.webId) {
      setIsSessionReady(true);
      return;
    }
    
    // Check if there are Solid session keys in localStorage
    const hasSolidSessionKeys = Object.keys(localStorage).some(k => 
      k.startsWith('solidClientAuthn') || k.startsWith('solidClientAuthenticationUser')
    );
    
    if (!hasSolidSessionKeys) {
      setIsSessionReady(true);
      return;
    }
    
    // Has session keys but not logged in yet - wait for session restore
    // Set a timeout to eventually mark as ready even if restore fails
    const timeout = setTimeout(() => {
      if (!isSessionReady) {
        setIsSessionReady(true);
      }
    }, 2000); 
    
    return () => clearTimeout(timeout);
  }, [session.isLoggedIn, session.webId, isSessionReady]);
  
  // Log Solid user status whenever it changes
  const prevSessionRef = useRef<{ isLoggedIn: boolean; webId: string | undefined }>({
    isLoggedIn: false,
    webId: undefined,
  });
  
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sessionChanged = 
        prevSessionRef.current.isLoggedIn !== session.isLoggedIn ||
        prevSessionRef.current.webId !== session.webId;
      
      if (sessionChanged) {
        
        prevSessionRef.current = {
          isLoggedIn: session.isLoggedIn,
          webId: session.webId,
        };
      }
    }
  }, [session.isLoggedIn, session.webId, isSolidUser, isSessionReady]);

  /**
   * Get or create the conversation history container
   */
  const getConversationContainer = useCallback(async (): Promise<Container | null> => {
    if (!session.webId) {
      return null;
    }

    try {
      const webIdResource = getResource(session.webId) as any;
      
      const rootResult = await webIdResource.getRootContainer();

      if (rootResult.isError) {
        return null;
      }
      
      // Create parent folders step by step (appData/, then llm-conversation-history/)
      // This handles the case where intermediate folders don't exist
      const folderParts = CONVERSATION_FOLDER.split('/').filter(p => p);
      let currentContainer = rootResult;
      
      for (const folderName of folderParts) {
        const childContainer = currentContainer.child(folderName + '/');
        
        const createResult = await childContainer.createIfAbsent();
        
        if (createResult.isError) {
          return null;
        }
        
        currentContainer = childContainer;
      }

      return currentContainer;
    } catch (err) {
      return null;
    }
  }, [session.webId, getResource]);

  /**
   * Update the _order.json file with conversation metadata
   */
  const updateOrderFile = useCallback(
    async (container: Container, conversationId: string, title: string) => {
      try {
        const orderFile = container.child(ORDER_FILE);
        let order: OrderItem[] = [];

        // Try to load existing order file
        try {
          const orderResource = getResource(orderFile.uri) as any;
          // Check if resource exists and is binary
          if (orderResource) {
            // Try to read the resource
            const readResult = await orderResource.read();
            if (!readResult.isError && readResult.resource && (readResult.resource as any).isBinary()) {
              const blob = (readResult.resource as any).getBlob();
              if (blob) {
                const text = await blob.text();
                order = JSON.parse(text);
              }
            }
          }
        } catch (e) {
          // File doesn't exist or is invalid, start fresh
          logger.debug('Solid Storage', 'Order file does not exist, creating new one');
        }

        // Update or add conversation to order
        const existingIndex = order.findIndex((item) => item.id === conversationId);
        const orderItem: OrderItem = {
          id: conversationId,
          title: title || 'Untitled',
          updatedAt: new Date().toISOString(),
        };

        if (existingIndex >= 0) {
          order[existingIndex] = orderItem;
        } else {
          order.unshift(orderItem); // Add to beginning
        }

        // Sort by updatedAt descending
        order.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        // Save order file to container
        const orderBlob = new Blob([JSON.stringify(order, null, 2)], {
          type: 'application/json',
        });

        const uploadResult = await container.uploadChildAndOverwrite(
          ORDER_FILE as LeafUri,
          orderBlob,
          'application/json',
        );

        if (uploadResult.isError) {
          logger.error('Solid Storage', 'Failed to update order file', uploadResult.message);
        }
      } catch (err) {
        logger.error('Solid Storage', 'Error updating order file', err);
      }
    },
    [getResource],
  );

  /**
   * Save a conversation to the Solid Pod
   */
  const saveConversation = useCallback(
    async (conversation: TConversation): Promise<{ isError: boolean; message?: string }> => {

      if (!isSolidUser) {
        return { isError: true, message: 'User is not logged in via Solid' };
      }

      setIsLoading(true);
      setError(null);

      try {
        const container = await getConversationContainer();
        if (!container) {
          const errorMsg = 'Failed to get conversation container';
          logger.error('Solid Storage', errorMsg);
          setError(errorMsg);
          return { isError: true, message: errorMsg };
        }

        // Create conversation file name using conversationId for uniqueness
        const fileName = `${conversation.conversationId}.json`;

        // Convert messages to stored format (only relevant fields)
        // Note: conversation.messages can be either string[] (IDs) or TMessage[] (full objects)
        // When coming from useEventHandlers, it will be TMessage[]
        const rawMessages = conversation.messages as unknown as TMessage[] | undefined;
        const storedMessages: StoredMessage[] = (rawMessages || []).map((msg: TMessage) => ({
          messageId: msg.messageId,
          conversationId: msg.conversationId ?? undefined,
          parentMessageId: msg.parentMessageId ?? undefined,
          text: msg.text || '',
          sender: msg.sender || (msg.isCreatedByUser ? 'User' : 'AI'),
          isCreatedByUser: msg.isCreatedByUser || false,
          model: msg.model ?? undefined,
          endpoint: msg.endpoint ?? undefined,
          createdAt: msg.createdAt ?? undefined,
          updatedAt: msg.updatedAt ?? undefined,
          content: msg.content,
          error: msg.error,
          finish_reason: msg.finish_reason ?? undefined,
        }));

        // Convert conversation to JSON format
        const conversationData: ConversationFile = {
          conversationId: conversation.conversationId,
          title: conversation.title || 'Untitled',
          messages: storedMessages,
          endpoint: conversation.endpoint ?? undefined,
          model: conversation.model ?? undefined,
          createdAt: conversation.createdAt ?? undefined,
          updatedAt: conversation.updatedAt || new Date().toISOString(),
          // Include other conversation fields
          temperature: conversation.temperature,
          top_p: conversation.top_p,
          system: conversation.system,
          promptPrefix: conversation.promptPrefix,
          agent_id: conversation.agent_id,
          assistant_id: conversation.assistant_id,
          spec: conversation.spec,
          tags: conversation.tags,
        };

        // Upload as JSON file
        const jsonData = JSON.stringify(conversationData, null, 2);

        const blob = new Blob([jsonData], {
          type: 'application/json',
        });

        logger.debug('Solid Storage', 'Uploading conversation file to Pod...');
        // Upload the file to the container (not to the file resource itself)
        const uploadResult = await container.uploadChildAndOverwrite(
          fileName as LeafUri,
          blob,
          'application/json',
        );

        if (uploadResult.isError) {
          const errorMsg = uploadResult.message || 'Failed to upload conversation';
          logger.error('Solid Storage', 'Failed to upload conversation', {
            error: errorMsg,
            fileName,
            conversationId: conversation.conversationId,
          });
          setError(errorMsg);
          setIsLoading(false);
          return { isError: true, message: errorMsg };
        }

        // Update order file
        await updateOrderFile(container, conversation.conversationId || '', conversation.title || 'Untitled');

        setIsLoading(false);

        return { isError: false };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error saving conversation';
        setError(errorMsg);
        setIsLoading(false);
        logger.error('Solid Storage', 'Error saving conversation', err);
        return { isError: true, message: errorMsg };
      }
    },
    [isSolidUser, getConversationContainer, updateOrderFile],
  );

  /**
   * Load all conversations from the Solid Pod
   */
  const loadConversations = useCallback(async (): Promise<TConversation[]> => {

    if (!isSolidUser) {
      return [];
    }

    setIsLoading(true);
    setError(null);

    try {
      const container = await getConversationContainer();
      if (!container) {
        setIsLoading(false);
        return [];
      }

      // Read the container to fetch its contents from the server
      const containerReadResult = await container.read();
      if (containerReadResult.isError) {
        logger.error('Solid Storage', 'Failed to read container', {
          error: containerReadResult.message,
        });
        setIsLoading(false);
        return [];
      }

      const conversations: TConversation[] = [];

      // Get all children (conversation files) - this should work now after read()
      let children = container.children();

      // If children() returns empty, try to manually find JSON files from the container resource
      if (children.length === 0) {
        // Try to get the container as a resource and check its data
        try {
          const containerResource = containerReadResult.resource as any;
          if (containerResource && typeof containerResource.children === 'function') {
            children = containerResource.children();
          }
        } catch (e) {
          logger.warn('Solid Storage', 'Failed to get children from containerResource', e);
        }
      }

      // If still no children, try using solidFetch to get the container listing directly
      if (children.length === 0 && solidFetch) {
        try {
          const response = await solidFetch(container.uri, {
            headers: { 'Accept': 'text/turtle' }
          });
          const turtle = await response.text();
          
          // Parse the turtle to find JSON files (look for ldp:contains)
          const jsonFileMatches = turtle.match(/<([^>]+\.json)>/g) || [];
          const jsonFiles = jsonFileMatches
            .map(m => m.slice(1, -1)) // Remove < and >
            .filter(uri => !uri.endsWith(ORDER_FILE));
          
          // Convert to child-like objects for processing
          children = jsonFiles.map(uri => {
            // Convert relative URIs to absolute
            const absoluteUri = uri.startsWith('http') ? uri : `${container.uri}${uri}`;
            return { type: 'leaf', uri: absoluteUri };
          }) as any;
        } catch (e) {
          logger.error('Solid Storage', 'Failed to fetch container directly', e);
        }
      }

      // Process each child
      for (const child of children) {
        // Check if it's a JSON file (not just 'leaf' type, as type might vary)
        const isJsonFile = child.uri.endsWith('.json') && !child.uri.endsWith(ORDER_FILE);
        
        if (isJsonFile) {
          try {
            let text: string | null = null;
            
            // Try using getResource first
            try {
              const resource = getResource(child.uri) as any;
              const readResult = await resource.read();
              
              if (!readResult.isError && readResult.resource && (readResult.resource as any).isBinary()) {
                const blob = (readResult.resource as any).getBlob();
                if (blob) {
                  text = await blob.text();
                }
              }
            } catch (e) {
              logger.debug('Solid Storage', 'getResource failed, trying session.fetch', { uri: child.uri, error: e });
            }
            
            // Fallback to solidFetch if getResource didn't work
            if (!text && solidFetch) {
              const response = await solidFetch(child.uri, {
                headers: { 'Accept': 'application/json' }
              });
              if (response.ok) {
                text = await response.text();
              } else {
                logger.warn('Solid Storage', 'session.fetch failed', { 
                  uri: child.uri, 
                  status: response.status 
                });
              }
            }
            
            if (!text) {
              continue;
            }
            
            const conversationData: ConversationFile = JSON.parse(text);
            
            // Convert stored messages back to TMessage format
            // Handle both StoredMessage format (from old saves) and TMessage format (from new saves)
           
            const rawMessages = conversationData.messages || [];
            
            // Check if all messages are strings (message IDs) - this indicates an old format we can't load
            if (rawMessages.length > 0 && rawMessages.every(msg => typeof msg === 'string')) {
              logger.warn('Solid Storage', 'Conversation has messages as IDs (strings) - cannot load without full message objects', {
                conversationId: conversationData.conversationId,
                messageCount: rawMessages.length,
              });
             
              continue;
            }
            
            const loadedMessages: TMessage[] = rawMessages
              .filter((msg) => {
                // Skip if msg is a string (messageId) - we need full message objects
                if (typeof msg === 'string') {
                  logger.warn('Solid Storage', 'Skipping message ID (string) - full message object required', {
                    messageId: msg,
                    conversationId: conversationData.conversationId,
                  });
                  return false;
                }
                return true;
              })
              .map((msg: StoredMessage | TMessage) => {
                // If it's already a TMessage (has all fields), use it directly
                if (typeof msg === 'object' && msg !== null && 'content' in msg && 'sender' in msg) {
                  return msg as TMessage;
                }
                // Otherwise, convert from StoredMessage format
                const storedMsg = msg as StoredMessage;
                return {
                  messageId: storedMsg.messageId,
                  conversationId: storedMsg.conversationId,
                  parentMessageId: storedMsg.parentMessageId,
                  text: storedMsg.text,
                  sender: storedMsg.sender,
                  isCreatedByUser: storedMsg.isCreatedByUser,
                  model: storedMsg.model,
                  endpoint: storedMsg.endpoint,
                  createdAt: storedMsg.createdAt,
                  updatedAt: storedMsg.updatedAt,
                  content: storedMsg.content,
                  error: storedMsg.error,
                  finish_reason: storedMsg.finish_reason,
                } as TMessage;
              });

            // Convert back to TConversation format
            const conversation: TConversation = {
              conversationId: conversationData.conversationId,
              title: conversationData.title,
              messages: loadedMessages.map(m => m.messageId), 
              endpoint: conversationData.endpoint,
              model: conversationData.model,
              createdAt: conversationData.createdAt,
              updatedAt: conversationData.updatedAt,
              temperature: conversationData.temperature,
              top_p: conversationData.top_p,
              system: conversationData.system,
              promptPrefix: conversationData.promptPrefix,
              agent_id: conversationData.agent_id,
              assistant_id: conversationData.assistant_id,
              spec: conversationData.spec,
              tags: conversationData.tags,
              files: conversationData.files,
            } as TConversation;
            
            // Store full messages in a temporary location so we can access them later
            (conversation as any)._fullMessages = loadedMessages;

            conversations.push(conversation);
          } catch (e) {
            logger.error('Solid Storage', `Failed to load conversation ${child.uri}`, {
              error: e,
              uri: child.uri,
            });
          }
        } else {
          logger.debug('Solid Storage', 'Skipping child (not a conversation file)', {
            type: child.type,
            uri: child.uri,
            isOrderFile: child.uri.endsWith(ORDER_FILE),
          });
        }
      }

      // Sort by updatedAt descending
      conversations.sort((a, b) => {
        const aDate = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bDate = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bDate - aDate;
      });

      setIsLoading(false);
   
      return conversations;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error loading conversations';
      setError(errorMsg);
      setIsLoading(false);
      logger.error('Solid Storage', 'Error loading conversations', err);
      return [];
    }
  }, [isSolidUser, getConversationContainer, getResource, solidFetch]);

  /**
   * Delete a conversation from the Solid Pod
   */
  const deleteConversation = useCallback(
    async (conversationId: string, title?: string): Promise<{ isError: boolean; message?: string }> => {

      if (!isSolidUser) {
        return { isError: true, message: 'User is not logged in via Solid' };
      }

      setIsLoading(true);
      setError(null);

      try {
        const container = await getConversationContainer();
        if (!container) {
          const errorMsg = 'Failed to get conversation container';
          logger.error('Solid Storage', errorMsg);
          setError(errorMsg);
          return { isError: true, message: errorMsg };
        }

        // Find the conversation file
        const fileName = `${sanitizeFileName(title || conversationId)}.json`;
        const fileResource = container.child(fileName);

        // Delete the file
        const deleteResult = await fileResource.delete();

        if (deleteResult.isError) {
          const errorMsg = deleteResult.message || 'Failed to delete conversation';
         
          setError(errorMsg);
          setIsLoading(false);
          return { isError: true, message: errorMsg };
        }

        // Update order file to remove the conversation
        const orderFile = container.child(ORDER_FILE);
        try {
          const orderResource = getResource(orderFile.uri) as any;
          if (orderResource) {
            const readResult = await orderResource.read();
            if (!readResult.isError && readResult.resource && (readResult.resource as any).isBinary()) {
              const blob = (readResult.resource as any).getBlob();
              if (blob) {
                const text = await blob.text();
                let order: OrderItem[] = JSON.parse(text);
                const beforeCount = order.length;
                order = order.filter((item) => item.id !== conversationId);
                const afterCount = order.length;

                const orderBlob = new Blob([JSON.stringify(order, null, 2)], {
                  type: 'application/json',
                });

                // Upload to container, not to the file resource
                await container.uploadChildAndOverwrite(ORDER_FILE as LeafUri, orderBlob, 'application/json');
              }
            }
          }
        } catch (e) {
          // Order file might not exist, that's okay
          logger.debug('Solid Storage', 'Order file not found or invalid during delete', {
            error: e,
          });
        }

        setIsLoading(false);
        return { isError: false };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error deleting conversation';
        setError(errorMsg);
        setIsLoading(false);

        return { isError: true, message: errorMsg };
      }
    },
    [isSolidUser, getConversationContainer, getResource],
  );

  return {
    isSolidUser,
    isSessionReady,
    isLoading,
    error,
    saveConversation,
    loadConversations,
    deleteConversation,
    getConversationContainer,
  };
}

