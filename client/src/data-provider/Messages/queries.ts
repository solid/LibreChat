import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import { useSolidStorage } from '~/hooks/useSolidStorage';
import { logger } from '~/utils';

export const useGetMessagesByConvoId = <TData = t.TMessage[]>(
  id: string,
  config?: UseQueryOptions<t.TMessage[], unknown, TData>,
): QueryObserverResult<TData> => {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { isSolidUser, isSessionReady, loadConversations } = useSolidStorage();
  
  // For Solid users: only need isSessionReady (they bypass normal auth)
  // For non-Solid users: respect the caller's enabled condition
  const callerEnabled = config?.enabled ?? true;
  const effectiveEnabled = isSessionReady && !!id && (isSolidUser || callerEnabled);
  
  return useQuery<t.TMessage[], unknown, TData>(
    [QueryKeys.messages, id],
    async () => {
      // For Solid users, load messages from Pod
      if (isSolidUser) {
        // First check cache - this will be updated by setFinalMessages during SSE
        const currentMessages = queryClient.getQueryData<t.TMessage[]>([QueryKeys.messages, id]);
        if (currentMessages && currentMessages.length > 0) {
          return currentMessages;
        }

        try {
          const conversations = await loadConversations();
          const conversation = conversations.find(c => c.conversationId === id);
          if (conversation) {
            // Check if full messages are attached (before they're moved to cache)
            const fullMessages = (conversation as any)._fullMessages as t.TMessage[] | undefined;
            if (fullMessages && fullMessages.length > 0) {
              // Store in cache for future use
              queryClient.setQueryData<t.TMessage[]>([QueryKeys.messages, id], fullMessages);
              return fullMessages;
            }
          }
        } catch (err) {
          logger.error('Solid Storage', 'Failed to load messages from Pod', { id, error: err });
        }
        
        return [];
      }
      
      const result = await dataService.getMessagesByConvoId(id);
      if (!location.pathname.includes('/c/new') && result?.length === 1) {
        const currentMessages = queryClient.getQueryData<t.TMessage[]>([QueryKeys.messages, id]);
        if (currentMessages?.length === 1) {
          return result;
        }
        if (currentMessages && currentMessages?.length > 1) {
          logger.warn(
            'messages',
            `Messages query for convo ${id} returned fewer than cache; path: "${location.pathname}"`,
            result,
            currentMessages,
          );
          return currentMessages;
        }
      }
      return result;
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      // Override enabled with our merged condition
      enabled: effectiveEnabled,
    },
  );
};
