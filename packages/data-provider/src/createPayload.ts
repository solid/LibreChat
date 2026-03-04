import type * as t from './types';
import { EndpointURLs } from './config';
import * as s from './schemas';

/**
 * Builds the request payload for the chat/agents API.
 *
 * When using Solid storage, the conversation object can come back with a different shape than
 * the rest of the app expects (e.g. after loading from the Pod ).
 * Without normalizing here, the first message in a conversation works, but continuing the
 * conversation (second message) fails because createPayload receives invalid or mismatched
 * data (messages as objects, null instead of undefined, model on conversation, etc.).
 * The normalization below ensures we always produce a valid payload for both the initial
 * and follow-up requests.
 */
export default function createPayload(submission: t.TSubmission) {
  const {
    isEdited,
    addedConvo,
    userMessage,
    isContinued,
    isTemporary,
    isRegenerate,
    conversation,
    editedContent,
    ephemeralAgent,
    endpointOption,
  } = submission;

  /**
   * Normalize conversation for Solid storage compatibility.
   * Solid can give us: messages as full objects with
   * messageId instead of an array of IDs; null instead of undefined for optional fields.
   * We convert to the shape tConvoUpdateSchema and downstream code expect.
   */
  let normalizedConversation: Record<string, unknown>;
  try {
    normalizedConversation = { ...conversation };

    // Messages: ensure we have an array of message IDs (schema expects string[]), not objects
    if (Array.isArray(normalizedConversation.messages)) {
      normalizedConversation.messages = normalizedConversation.messages.map((msg: unknown) => {
        if (typeof msg === 'string') {
          return msg;
        }
        if (typeof msg === 'object' && msg !== null && 'messageId' in msg) {
          return (msg as { messageId: string }).messageId;
        }
        return String(msg);
      }) as string[];
    }
  } catch {
    normalizedConversation = conversation as Record<string, unknown>;
  }

  /**
   * Zod .optional() means "undefined is valid", not null. JSON/Storage often use null for
   * missing optional fields. Convert null → undefined so schema parse succeeds.
   */
  const nullableNumberFields = [
    'topP',
    'top_p',
    'topK',
    'frequency_penalty',
    'presence_penalty',
    'temperature',
    'maxOutputTokens',
    'maxContextTokens',
    'max_tokens',
    'thinkingBudget',
    'fileTokenLimit',
  ];

  const nullableStringFields = [
    'assistant_id',
    'agent_id',
    'model',
    'modelLabel',
    'userLabel',
    'promptPrefix',
    'system',
    'context',
    'title',
    'conversationId',
    'endpoint',
    'endpointType',
    'parentMessageId',
    'artifacts',
    'imageDetail',
    'reasoning_effort',
    'reasoning_summary',
    'verbosity',
  ];

  const nullableBooleanFields = ['isArchived', 'promptCache', 'thinking', 'stream', 'resendFiles'];

  // Convert null to undefined for all nullable fields
  for (const field of nullableNumberFields) {
    if (field in normalizedConversation && normalizedConversation[field] === null) {
      normalizedConversation[field] = undefined;
    }
  }

  for (const field of nullableStringFields) {
    if (field in normalizedConversation && normalizedConversation[field] === null) {
      normalizedConversation[field] = undefined;
    }
  }

  for (const field of nullableBooleanFields) {
    if (field in normalizedConversation && normalizedConversation[field] === null) {
      normalizedConversation[field] = undefined;
    }
  }

  // Handle createdAt and updatedAt - convert Date objects to strings, or null to undefined
  if ('createdAt' in normalizedConversation) {
    if (normalizedConversation.createdAt === null) {
      normalizedConversation.createdAt = undefined;
    } else if (normalizedConversation.createdAt instanceof Date) {
      normalizedConversation.createdAt = normalizedConversation.createdAt.toISOString();
    }
  }

  if ('updatedAt' in normalizedConversation) {
    if (normalizedConversation.updatedAt === null) {
      normalizedConversation.updatedAt = undefined;
    } else if (normalizedConversation.updatedAt instanceof Date) {
      normalizedConversation.updatedAt = normalizedConversation.updatedAt.toISOString();
    }
  }

  /**
   * Use safeParse so we don't throw on invalid/conversation shapes (e.g. from Solid).
   * If parse fails, we still try to build a valid payload from conversation + endpointOption
   * (fallback below) so follow-up messages can succeed.
   */
  const parseResult = s.tConvoUpdateSchema.safeParse(normalizedConversation);

  if (!parseResult.success) {
    // Fallback: build payload from raw conversationId and conversation/endpointOption fields
    // (e.g. new convo: conversationId null/'new'; existing: we need conversationId + model etc.)
    const conversationIdRaw =
      conversation?.conversationId ?? normalizedConversation?.conversationId ?? null;

    // Allow null or 'new' for new conversations
    if (conversationIdRaw === null || conversationIdRaw === 'new') {
      const conversationId = conversationIdRaw;
      const { endpoint: _e, endpointType } = endpointOption as {
        endpoint: s.EModelEndpoint;
        endpointType?: s.EModelEndpoint;
      };

      const endpoint = _e as s.EModelEndpoint;
      let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;
      if (s.isAssistantsEndpoint(endpoint)) {
        server =
          EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
          (isEdited ? '/modify' : '');
      }

      const payload: t.TPayload = {
        ...userMessage,
        ...endpointOption,
        endpoint,
        addedConvo,
        isTemporary,
        isRegenerate,
        editedContent,
        conversationId: conversationId as string | null,
        isContinued: !!(isEdited && isContinued),
        ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
      };

      return { server, payload };
    }

    // For existing conversations, conversationId must be a valid string
    if (typeof conversationIdRaw !== 'string') {
      throw new Error('Invalid conversation: conversationId must be a string');
    }

    const conversationId: string = conversationIdRaw;

    // Solid often stores model (and other options) on the conversation; pull from conversation
    // when not in endpointOption so the payload has a model for the backend.
    const conversationFields = {
      model:
        (endpointOption as { model?: string })?.model ??
        conversation?.model ??
        normalizedConversation?.model,
      modelLabel:
        (endpointOption as { modelLabel?: string })?.modelLabel ??
        conversation?.modelLabel ??
        normalizedConversation?.modelLabel,
      temperature:
        (endpointOption as { temperature?: number })?.temperature ??
        conversation?.temperature ??
        normalizedConversation?.temperature,
      topP:
        (endpointOption as { topP?: number })?.topP ??
        conversation?.topP ??
        normalizedConversation?.topP,
      top_p:
        (endpointOption as { top_p?: number })?.top_p ??
        conversation?.top_p ??
        normalizedConversation?.top_p,
      frequency_penalty:
        (endpointOption as { frequency_penalty?: number })?.frequency_penalty ??
        conversation?.frequency_penalty ??
        normalizedConversation?.frequency_penalty,
      presence_penalty:
        (endpointOption as { presence_penalty?: number })?.presence_penalty ??
        conversation?.presence_penalty ??
        normalizedConversation?.presence_penalty,
      maxOutputTokens:
        (endpointOption as { maxOutputTokens?: number })?.maxOutputTokens ??
        conversation?.maxOutputTokens ??
        normalizedConversation?.maxOutputTokens,
      max_tokens:
        (endpointOption as { max_tokens?: number })?.max_tokens ??
        conversation?.max_tokens ??
        normalizedConversation?.max_tokens,
      system:
        (endpointOption as { system?: string })?.system ??
        conversation?.system ??
        normalizedConversation?.system,
      promptPrefix:
        (endpointOption as { promptPrefix?: string })?.promptPrefix ??
        conversation?.promptPrefix ??
        normalizedConversation?.promptPrefix,
    };

    // Filter out null/undefined values
    const validConversationFields = Object.fromEntries(
      Object.entries(conversationFields).filter(
        ([_, value]) => value !== null && value !== undefined,
      ),
    );

    // Continue with the fallback conversationId
    const { endpoint: _e, endpointType } = endpointOption as {
      endpoint: s.EModelEndpoint;
      endpointType?: s.EModelEndpoint;
    };

    const endpoint = _e as s.EModelEndpoint;
    let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;
    if (s.isAssistantsEndpoint(endpoint)) {
      server =
        EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
        (isEdited ? '/modify' : '');
    }

    // Ensure model is explicitly included - check all sources
    const finalModel =
      (endpointOption as { model?: string })?.model ||
      validConversationFields.model ||
      conversation?.model ||
      normalizedConversation?.model;

    // Extract resendFiles - default to true for agents endpoints if not specified
    const resendFilesFromOption = (endpointOption as { resendFiles?: boolean })?.resendFiles;
    const resendFilesFromConversation =
      typeof conversation?.resendFiles === 'boolean' ? conversation.resendFiles : undefined;
    const resendFilesFromNormalized =
      typeof normalizedConversation?.resendFiles === 'boolean'
        ? (normalizedConversation.resendFiles as boolean)
        : undefined;
    const resendFiles: boolean =
      resendFilesFromOption ??
      resendFilesFromConversation ??
      resendFilesFromNormalized ??
      (s.isAgentsEndpoint(endpoint) ? true : false);

    const payload: t.TPayload = {
      ...userMessage,
      ...endpointOption,
      ...validConversationFields, // Merge conversation fields, with endpointOption taking precedence
      endpoint,
      addedConvo,
      isTemporary,
      isRegenerate,
      editedContent,
      conversationId,
      isContinued: !!(isEdited && isContinued),
      ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
      // Explicitly include model at top level - this ensures it's always in the payload if available
      ...(finalModel ? { model: finalModel as string } : {}),
      // Explicitly include resendFiles - always true for agents endpoints if not specified
      ...(s.isAgentsEndpoint(endpoint) ? { resendFiles } : {}),
    };

    return { server, payload };
  }
  const { conversationId } = parseResult.data;
  const { endpoint: _e, endpointType } = endpointOption as {
    endpoint: s.EModelEndpoint;
    endpointType?: s.EModelEndpoint;
  };

  const endpoint = _e as s.EModelEndpoint;
  let server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;
  if (s.isAssistantsEndpoint(endpoint)) {
    server =
      EndpointURLs[(endpointType ?? endpoint) as 'assistants' | 'azureAssistants'] +
      (isEdited ? '/modify' : '');
  }

  // Model can live on the conversation when loaded from Solid; include it in payload if present
  const modelFromConversation = conversation?.model ?? normalizedConversation?.model;
  const modelFromEndpointOption = (endpointOption as { model?: string })?.model;
  const finalModel = (modelFromEndpointOption || modelFromConversation) as string | undefined;

  // Extract resendFiles - default to true for agents endpoints if not specified
  const resendFilesFromOption = (endpointOption as { resendFiles?: boolean })?.resendFiles;
  const resendFilesFromConversation =
    typeof conversation?.resendFiles === 'boolean' ? conversation.resendFiles : undefined;
  const resendFilesFromNormalized =
    typeof normalizedConversation?.resendFiles === 'boolean'
      ? (normalizedConversation.resendFiles as boolean)
      : undefined;
  const resendFiles: boolean =
    resendFilesFromOption ??
    resendFilesFromConversation ??
    resendFilesFromNormalized ??
    (s.isAgentsEndpoint(endpoint) ? true : false);

  const payload: t.TPayload = {
    ...userMessage,
    ...endpointOption,
    endpoint,
    addedConvo,
    isTemporary,
    isRegenerate,
    editedContent,
    conversationId,
    isContinued: !!(isEdited && isContinued),
    ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
    // Explicitly include model at top level for buildEndpointOption to find it
    ...(finalModel ? { model: finalModel } : {}),
    // Explicitly include resendFiles - always true for agents endpoints if not specified
    ...(s.isAgentsEndpoint(endpoint) ? { resendFiles } : {}),
  };

  return { server, payload };
}
