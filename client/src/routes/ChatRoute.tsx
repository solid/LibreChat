import { useEffect, useState } from 'react';
import { Spinner } from '@librechat/client';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { TPreset, TConversation, TMessage } from 'librechat-data-provider';
import { useGetConvoIdQuery, useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import { useNewConvo, useAppStartup, useAssistantListMap, useIdChangeEffect } from '~/hooks';
import { useSolidStorage } from '~/hooks/useSolidStorage';
import { getDefaultModelSpec, getModelSpecPreset, logger } from '~/utils';
import { ToolCallsMapProvider } from '~/Providers';
import ChatView from '~/components/Chat/ChatView';
import useAuthRedirect from './useAuthRedirect';
import temporaryStore from '~/store/temporary';
import { useRecoilCallback } from 'recoil';
import store from '~/store';

export default function ChatRoute() {
  const { data: startupConfig } = useGetStartupConfig();
  const { isAuthenticated, user } = useAuthRedirect();
  const [searchParams] = useSearchParams();
  const { isSolidUser } = useSolidStorage();
  const navigate = useNavigate();
  
  // Check if we have Solid OIDC callback params or auth in progress
  const checkSolidAuth = () => {
    if (typeof window !== 'undefined') {
      const authInProgress = sessionStorage.getItem('solid_auth_in_progress') === 'true';
      if (authInProgress) {
        return true;
      }
    }
    // Fallback to URL params
    return searchParams.has('code') && searchParams.has('state');
  };
  
  const hasSolidCallback = checkSolidAuth();
  
  // For Solid users, we can proceed even if isAuthenticated is false
  // (the Solid session is our source of truth)
  const effectivelyAuthenticated = isAuthenticated || isSolidUser;

  const setIsTemporary = useRecoilCallback(
    ({ set }) =>
      (value: boolean) => {
        set(temporaryStore.isTemporary, value);
      },
    [],
  );
  useAppStartup({ startupConfig, user });

  const index = 0;
  const { conversationId: rawConversationId = '' } = useParams();
  
  // Check if conversationId is an encoded Pod URL
  const isEncodedPodUrl = rawConversationId.startsWith('https%3A%2F%2F') || rawConversationId.startsWith('http%3A%2F%2F');
  const podUrl = isEncodedPodUrl ? decodeURIComponent(rawConversationId) : null;
  const conversationId = isEncodedPodUrl ? null : rawConversationId;
  
  useIdChangeEffect(conversationId || '');
  const { hasSetConversation, conversation } = store.useCreateConversationAtom(index);
  const { newConversation } = useNewConvo();
  const { loadConversationFromPod: loadFromPod } = useSolidStorage();
  const queryClient = useQueryClient();
  const [sharedConversation, setSharedConversation] = useState<TConversation | null>(null);
  const [isLoadingShared, setIsLoadingShared] = useState(false);

  // Load shared conversation from Pod URL if needed
  useEffect(() => {
    if (podUrl && !isLoadingShared && !sharedConversation) {
      setIsLoadingShared(true);
      loadFromPod(podUrl)
        .then((convo) => {
          if (convo) {
            setSharedConversation(convo);
            // Store messages in cache
            const messages = (convo as any)._fullMessages as TMessage[] | undefined;
            if (messages && convo.conversationId) {
              queryClient.setQueryData<TMessage[]>([QueryKeys.messages, convo.conversationId], messages);
              // Remove the temporary _fullMessages property
              delete (convo as any)._fullMessages;
            }
          }
        })
        .catch((err) => {
          logger.error('ChatRoute', 'Failed to load shared conversation', err);
        })
        .finally(() => {
          setIsLoadingShared(false);
        });
    }
  }, [podUrl, loadFromPod, isLoadingShared, sharedConversation]);

  const modelsQuery = useGetModelsQuery({
    enabled: effectivelyAuthenticated,
    refetchOnMount: 'always',
  });
  const initialConvoQuery = useGetConvoIdQuery(conversationId || '', {
    enabled:
      effectivelyAuthenticated &&
      conversationId !== Constants.NEW_CONVO &&
      !hasSetConversation.current &&
      !isEncodedPodUrl,
  });
  const endpointsQuery = useGetEndpointsQuery({ enabled: effectivelyAuthenticated });
  const assistantListMap = useAssistantListMap();

  const isTemporaryChat = conversation && conversation.expiredAt ? true : false;

  // Listen for archive navigation event
  useEffect(() => {
    const handleArchiveNavigation = (event: CustomEvent<{ conversationId: string }>) => {
      if (event.detail.conversationId === conversationId) {
        // Navigate to new chat when current conversation is archived
        navigate('/c/new', { replace: true });
      }
    };

    window.addEventListener('archive-navigation', handleArchiveNavigation as EventListener);
    return () => {
      window.removeEventListener('archive-navigation', handleArchiveNavigation as EventListener);
    };
  }, [conversationId, navigate]);

  // Check if conversation is archived and redirect
  useEffect(() => {
    if (
      conversationId &&
      conversationId !== Constants.NEW_CONVO &&
      initialConvoQuery.data &&
      initialConvoQuery.data.isArchived === true
    ) {
      navigate('/c/new', { replace: true });
    }
  }, [conversationId, initialConvoQuery.data, navigate]);

  useEffect(() => {
    if (conversationId !== Constants.NEW_CONVO && !isTemporaryChat) {
      setIsTemporary(false);
    } else if (isTemporaryChat) {
      setIsTemporary(isTemporaryChat);
    }
  }, [conversationId, isTemporaryChat, setIsTemporary]);

  /** This effect is mainly for the first conversation state change on first load of the page.
   *  Adjusting this may have unintended consequences on the conversation state.
   */
  useEffect(() => {
    const shouldSetConvo =
      (startupConfig && !hasSetConversation.current && !modelsQuery.data?.initial) ?? false;
    /* Early exit if startupConfig is not loaded and conversation is already set and only initial models have loaded */
    if (!shouldSetConvo) {
      return;
    }

    if (conversationId === Constants.NEW_CONVO && endpointsQuery.data && modelsQuery.data) {
      const result = getDefaultModelSpec(startupConfig);
      const spec = result?.default ?? result?.last;
      logger.log('conversation', 'ChatRoute, new convo effect', conversation);
      newConversation({
        modelsData: modelsQuery.data,
        template: conversation ? conversation : undefined,
        ...(spec ? { preset: getModelSpecPreset(spec) } : {}),
      });

      hasSetConversation.current = true;
    } else if (sharedConversation && endpointsQuery.data && modelsQuery.data) {
      newConversation({
        template: sharedConversation,
        preset: sharedConversation as TPreset,
        modelsData: modelsQuery.data,
        keepLatestMessage: true,
      });
      hasSetConversation.current = true;
    } else if (initialConvoQuery.data && endpointsQuery.data && modelsQuery.data) {
      logger.log('conversation', 'ChatRoute initialConvoQuery', initialConvoQuery.data);
      newConversation({
        template: initialConvoQuery.data,
        /* this is necessary to load all existing settings */
        preset: initialConvoQuery.data as TPreset,
        modelsData: modelsQuery.data,
        keepLatestMessage: true,
      });
      hasSetConversation.current = true;
    } else if (
      conversationId === Constants.NEW_CONVO &&
      assistantListMap[EModelEndpoint.assistants] &&
      assistantListMap[EModelEndpoint.azureAssistants]
    ) {
      const result = getDefaultModelSpec(startupConfig);
      const spec = result?.default ?? result?.last;
      logger.log('conversation', 'ChatRoute new convo, assistants effect', conversation);
      newConversation({
        modelsData: modelsQuery.data,
        template: conversation ? conversation : undefined,
        ...(spec ? { preset: getModelSpecPreset(spec) } : {}),
      });
      hasSetConversation.current = true;
    } else if (
      assistantListMap[EModelEndpoint.assistants] &&
      assistantListMap[EModelEndpoint.azureAssistants]
    ) {
      logger.log('conversation', 'ChatRoute convo, assistants effect', initialConvoQuery.data);
      newConversation({
        template: initialConvoQuery.data,
        preset: initialConvoQuery.data as TPreset,
        modelsData: modelsQuery.data,
        keepLatestMessage: true,
      });
      hasSetConversation.current = true;
    }
    /* Creates infinite render if all dependencies included due to newConversation invocations exceeding call stack before hasSetConversation.current becomes truthy */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    startupConfig,
    initialConvoQuery.data,
    endpointsQuery.data,
    modelsQuery.data,
    assistantListMap,
  ]);

  if (endpointsQuery.isLoading || modelsQuery.isLoading || (isEncodedPodUrl && isLoadingShared)) {
    return (
      <div className="flex h-screen items-center justify-center" aria-live="polite" role="status">
        <Spinner className="text-text-primary" />
      </div>
    );
  }

  // Allow rendering if we have Solid callback params (authentication in progress) or if Solid user
  if (!effectivelyAuthenticated && !hasSolidCallback) {
    return null;
  }

  // if not a conversation
  if (conversation?.conversationId === Constants.SEARCH) {
    return null;
  }
  // For shared conversations from Pod URL, use sharedConversation
  const effectiveConversation = isEncodedPodUrl ? sharedConversation : conversation;
  
  // if conversationId not match (only for non-shared conversations)
  if (!isEncodedPodUrl && effectiveConversation?.conversationId !== conversationId && !effectiveConversation) {
    return null;
  }
  // if conversationId is null (only for non-shared conversations)
  if (!isEncodedPodUrl && !conversationId) {
    return null;
  }
  
  // For shared conversations, ensure we have the conversation loaded
  if (isEncodedPodUrl && !sharedConversation) {
    return null;
  }

  return (
    <ToolCallsMapProvider conversationId={effectiveConversation?.conversationId ?? ''}>
      <ChatView index={index} />
    </ToolCallsMapProvider>
  );
}
