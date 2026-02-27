# Solid Pod Integration - Progress Report

## Overview
Successfully implemented Solid Pod storage integration for LibreChat, enabling users to store conversations and messages in their personal Solid Pods instead of (or alongside) MongoDB.

## Completed Milestones

### 1. Authentication & Token Management
- **Status**: Complete
- **Details**: 
  - Integrated Solid-OIDC authentication flow
  - Captured and logged authorization codes from Solid provider
  - Implemented token storage in session and cookies
  - Handled cases where Solid provider doesn't issue refresh tokens
  - Ensured JWT tokens are created for frontend authentication
  - Added separate "Login with Solid" button with custom branding
  - Supports both generic OpenID and Solid-specific authentication buttons
  - Both buttons use the same authentication flow but with different labels and icons

### 2. Solid Pod Access
- **Status**: Complete
- **Details**:
  - Implemented authenticated fetch using OpenID access tokens
  - Created Pod URL discovery with fallback mechanism
  - Derived Pod URLs from WebID when not found in profile
  - Verified Pod accessibility before operations

### 3. Container Management
- **Status**: Complete
- **Details**:
  - Implemented automatic container creation for base storage structure
  - Created `/librechat/`, `/librechat/conversations/`, and `/librechat/messages/` containers
  - Used HTTP HEAD requests to check container existence
  - Properly parsed Turtle (RDF) format responses from Solid Pods

### 4. Message Storage
- **Status**: Complete
- **Details**:
  - Implemented `saveMessageToSolid` - saves individual messages as JSON files
  - Messages stored in: `/librechat/messages/{conversationId}/{messageId}.json`
  - Successfully tested: User messages are being saved to Pod
  - Proper error handling and logging

### 5. Conversation Storage
- **Status**: Complete
- **Details**:
  - Implemented `saveConvoToSolid` - saves conversations as JSON files
  - Conversations stored in: `/librechat/conversations/{conversationId}.json`
  - Successfully tested: Conversations are being created in Pod
  - Includes message references and metadata

### 6. Data Retrieval
- **Status**: Complete
- **Details**:
  - Implemented `getMessagesFromSolid` - retrieves all messages for a conversation
  - Implemented `getConvosByCursorFromSolid` - retrieves conversations with pagination
  - Properly parses Turtle format to extract `ldp:contains` items
  - Handles empty containers gracefully (returns empty arrays, not errors)

### 7. Storage Backend Selection (No Feature Flag)
- **Status**: Complete
- **Details**:
  - Storage backend is determined by how the user logged in: **"Continue with Solid"** → Solid Pod; **"Continue with OpenID"** or other → MongoDB
  - Users who click "Continue with Solid" have `provider === 'solid'`; only those get Solid storage
  - Integrated Solid storage in `Message.js`, `Conversation.js`, routes, and share methods
  - Shared `isSolidUser(req)` helper in `api/server/utils/isSolidUser.js` used everywhere (DRY)
  - Maintains backward compatibility with MongoDB for all non-Solid users

### 8. Conversation Access Validation & No MongoDB Fallback for Solid Users
- **Status**: Complete
- **Details**:
  - Updated `validateConvoAccess` middleware to check Solid storage
  - Modified `searchConversation` to query Solid Pod when the user logged in via "Continue with Solid" (`provider === 'solid'`)
  - Ensures users can only access their own conversations from Solid Pod
  - **No MongoDB fallback for Solid users (per PR review)**: When a user is logged in with Solid, we never fall back to MongoDB on Solid failure or null. Errors are surfaced so the UI can show "Save failed" or "Load failed" instead of writing/reading from the wrong store:
    - **Conversation.js**: `searchConversation`, `getConvo`, `saveConvo`, `getConvosByCursor` return null or rethrow for Solid users; no MongoDB path
    - **validateMessageReq.js**: Solid users get 404 if conversation not in Solid; no MongoDB lookup
    - **messages.js** routes: Solid errors return 503 with "Solid storage temporarily unavailable"; no MongoDB read
  - Non-Solid users continue to use MongoDB only

### 9. Payload Normalization & Model Extraction
- **Status**: Complete
- **Details**:
  - Implemented conversation object normalization in `createPayload` for Solid storage compatibility
  - Handles Solid storage format differences (messages as objects vs IDs, null vs undefined)
  - Added fallback mechanism for schema validation failures
  - Extracts `model` and `endpoint` from messages when missing in conversation metadata
  - Ensures `resendFiles` is included in payloads for agents endpoints (defaults to `true`)
  - **buildEndpointOption** (per PR review): Uses storage-agnostic `getConvo(req.user.id, conversationId, req)` to fill missing model; no Solid-specific logic in that middleware—storage is chosen in the model layer

### 10. Full Conversation Flow
- **Status**: Complete
- **Details**:
  - Users can start new conversations
  - Users can continue existing conversations
  - Model information is correctly extracted and passed through the request chain
  - All required payload fields are included for agents endpoints

### 11. Title Persistence
- **Status**: Complete
- **Details**:
  - Conversation titles are properly saved to Solid Pod when generated
  - Titles persist correctly after page refresh and after sending more messages
  - `saveConvo` correctly identifies Solid users before saving to Solid Pod
  - **saveConvoToSolid** merges existing Pod conversation into the incoming document before writing, so partial updates (e.g. after POST message or BaseClient saveConvo) preserve fields like `title` instead of overwriting the file and losing the generated title

### 12. Conversation Management Operations
- **Status**: Complete
- **Details**:
  - **Rename**: Working - Users can rename conversations stored in Solid Pod
  - **Duplicate**: Working - Users can duplicate conversations and all messages from Solid Pod
  - **Delete**: Working - Users can delete conversations and all associated messages from Solid Pod
  - **Archive**: Working - Users can archive and unarchive conversations stored in Solid Pod
  - **Share**: Working - Users can share conversations stored in Solid Pod with public read access while maintaining owner write permissions

### 13. Share Functionality
- **Status**: Complete
- **Details**:
  - Implemented public read access via ACL (Access Control List) for shared conversations
  - Uses manual ACL Turtle format for reliable permission management
  - Preserves owner permissions (Write, Append, Control) when granting public read access
  - Applies `acl:default` on message containers so new messages automatically inherit public access
  - Dynamically detects Solid users and routes to appropriate sharing method
  - Fetches shared messages directly from Pod using unauthenticated requests
  - Properly removes public access when share is deleted

### 14. Schema-Aligned Document Content (PR Review)
- **Status**: Complete
- **Details**:
  - **Single source of document shape**: JSON written to the Solid Pod now matches the same document shape as MongoDB; shape is defined in the model layer and aligned with `packages/data-schemas` (message + convo schema and types).
  - **Messages**: `Message.js` builds the full message document (including `user`, `createdAt`, `updatedAt`) and passes it to `saveMessageToSolid`. SolidStorage only validates ids, resolves paths, and writes that document; the previous hand-built field list and defaults in SolidStorage were removed.
  - **Conversations**: `Conversation.js` builds the full conversation document (conversationId, user, …convo, expiredAt, `previousConversationId` when renaming) and passes it to `saveConvoToSolid`. SolidStorage only adds Pod-specific data (message refs from the Pod, timestamps, optional model/endpoint fallback from messages), then merges with existing Pod conversation (to preserve e.g. title on partial updates) and writes. It no longer constructs the conversation payload from a custom field list.
  - **Partial updates**: When the caller sends a partial update (e.g. after sending a message with no `title`), existing conversation from the Pod is merged into the incoming document before writing so fields like `title` are preserved.

### 15. PR Review: Config, Logging, Convos
- **Status**: Complete
- **Details**:
  - **config.js**: `openidLoginEnabled` set to `isOpenIdEnabled` only (removed `|| isSolidEnabled`) so when only Solid is enabled the login page shows one Solid button, not both OpenID and Solid.
  - **requireJwtAuth.js**: Removed non–Solid-specific debug logging added during auth flow debugging; reviewer suggested upstreaming useful logging in a separate PR if needed.
  - **convos.js**: No code change; reviewer concern addressed by clarification—`getConvo(req.user.id, conversationId, req)` in `Conversation.js` already branches on `isSolidUser(req)` and uses Solid when the user is a Solid user.

### 16. Refresh Token Support & Post-Login API Auth (Solid-Only Config)
- **Status**: Complete
- **Details**:
  - **Post-login redirect**: After Solid OAuth callback, the server redirects to `DOMAIN_CLIENT`; the client then calls `/api/auth/refresh`. When the IdP does not return a refresh token, we return `{ token, user }` from session (decode id_token for `sub`, find user by openidId). When a refresh token *is* present, `performOpenIDRefresh` exchanges it for new tokens and returns `{ token, user }`.
  - **Refresh token**: When the Solid IdP (e.g. Local CSS) returns a refresh token in the token response, we receive it, store it in session (`req.session.openidTokens.refreshToken`) and in the `refreshToken` cookie, and use it in `/api/auth/refresh` via `performOpenIDRefresh` + `openIdClient.refreshTokenGrant`. So **yes, we now receive and use a refresh token** when the IdP provides one.
  - **prompt=consent**: Solid authorization request sends `prompt=consent` and `scope=openid webid offline_access` so IdPs that support it can issue a refresh token.
  - **JWT strategy by provider**: `requireJwtAuth` and `optionalJwtAuth` use `solidJwt` when `token_provider === 'solid'` and `openidJwt` when `token_provider === 'openid'`, so API requests after Solid login authenticate correctly when only Solid is configured (generic OpenID may be unregistered e.g. due to HTTPS requirement).
  - **token_provider cookie must stay `solid`**: The cookie is set from `req.user?.provider` in `setOpenIDAuthTokens`. (1) **OAuth callback**: Solid strategy return value now explicitly includes `provider: 'solid'` so the callback sets `token_provider=solid`. (2) **Refresh path**: When the frontend calls refresh, we pass `token_provider` from the request cookie into `performOpenIDRefresh` and set `req.user = user` and `user.provider = user.provider || tokenProvider` before calling `setOpenIDAuthTokens`, so the cookie is not overwritten to `openid` and subsequent API calls use solidJwt.
  - **solidJwt registration**: Uses `getSolidOpenIdProvidersForJwt()` (from `SOLID_OPENID_PROVIDERS` or, when that list is empty, a synthetic Local CSS provider when `SOLID_OPENID_CUSTOM_CLIENT_ID` is set). Registration runs at startup in socialLogins and lazily in auth middleware if the strategy was not registered (e.g. IdP was down).
  - **JWT from cookie fallback**: The openIdJwt strategy (used by solidJwt) extracts the JWT from `Authorization: Bearer` first, then from the `openid_id_token` cookie, so the first API request after redirect (before the frontend refresh sets the header) can still authenticate. When storing tokens in session we also set the `openid_id_token` cookie so that fallback works.
  - **DRY**: Shared `sendStrategyNotRegistered503(res, tokenProvider, afterLazyInit)` in `api/server/middleware/openIdAuthHelpers.js` used by both `requireJwtAuth` and `optionalJwtAuth` for 503 responses when the OpenID/Solid strategy is not registered. Unnecessary logging removed (setOpenIDAuthTokens debug, 503 warns, Solid “no providers” debug, extra configureSolidOpenIdFromProviders info).
- **Config**:
  - **Dynamic-only**: Solid provider list comes from `SOLID_OPENID_PROVIDERS` only; legacy `SOLID_OPENID_ISSUER` is no longer used. `SOLID_OPENID_CUSTOM_CLIENT_ID` allows custom issuer URLs (e.g. user picks “Local CSS” from modal) with a single client id; `getSolidOpenIdProvidersForJwt()` returns a synthetic provider for Local CSS when only custom client id is set so solidJwt can still register.
- **Findings**:
  - **Local CSS** with dynamic client registration (`/solid-client-id` document) can return a refresh token when configured to do so; we store and use it. With `prompt=consent` and `offline_access` scope, IdPs that support it will include a refresh token.
  - **solidcommunity.net**: The IdP dereferences the client_id URL; a localhost client_id is not reachable. Use a public URL for production.
  - **SOLID_OPENID_SCOPE**: Use `"openid webid offline_access"` for refresh token support when the IdP supports it.

## Current Status

### Working Features
1. **User Login**: Solid-OIDC authentication working correctly with dedicated "Login with Solid" button
2. **Separate Authentication Buttons**: Both "Login with OpenID" and "Login with Solid" buttons available with custom labels and icons
3. **Conversation Creation**: New conversations are saved to Solid Pod
4. **Message Saving**: User messages and AI responses are saved to Solid Pod
5. **Data Retrieval**: Conversations and messages can be read from Pod
6. **Container Structure**: Proper directory structure created automatically
7. **Conversation Continuation**: Users can send multiple messages in the same conversation
8. **Model Persistence**: Model and endpoint information is correctly stored and retrieved
9. **Access Control**: Conversation access validation works for Solid storage users
10. **Title Persistence**: Conversation titles are saved to Solid Pod and persist after page refresh
11. **Conversation Rename**: Users can rename conversations stored in Solid Pod
12. **Conversation Duplicate**: Users can duplicate conversations and all their messages from Solid Pod
13. **Conversation Delete**: Users can delete conversations and all associated messages from Solid Pod
14. **Conversation Archive**: Users can archive and unarchive conversations stored in Solid Pod
15. **Conversation Share**: Users can share conversations stored in Solid Pod with public read access while maintaining full write permissions

### Known Issues 🔧
None currently identified.

## Technical Implementation

### Storage Format
- **Format**: JSON files
- **Structure**:
  ```
  /librechat/
    /conversations/
      {conversationId}.json
    /messages/
      {conversationId}/
        {messageId}.json
  ```

### Parsing Logic
- Uses HTTP GET requests to retrieve container contents
- Parses Turtle (RDF) format responses
- Extracts `ldp:contains` predicates to list files
- Handles relative and absolute URLs

### Authentication
- Uses OpenID access tokens stored in session
- Falls back to cookies if session unavailable
- Tokens retrieved from multiple sources for robustness
- Separate "Login with Solid" button using `SOLID_OPENID_*` environment variables
- Generic "Login with OpenID" button using `OPENID_*` environment variables
- Both buttons share the same authentication flow and `/oauth/openid` route
- Custom SolidIcon component for Solid branding
- **Refresh token**: When the IdP returns a refresh token, it is stored in session (and cookie when present) and used by `/api/auth/refresh` via `performOpenIDRefresh` to obtain new tokens. When no refresh token is returned, a session fallback returns the current session token and user so the client does not redirect to `/login`.
- **Authorization request**: Solid flow sends `prompt=consent` and `scope=openid webid offline_access` so IdPs that support it can issue a refresh token.
- **JWT strategies**: Solid uses `solidJwt`, generic OpenID uses `openidJwt`; `requireJwtAuth` and `optionalJwtAuth` select the strategy based on the `token_provider` cookie. The cookie is set from `req.user.provider` in `setOpenIDAuthTokens`; the refresh path passes `token_provider` into `performOpenIDRefresh` and sets `req.user`/`user.provider` so the cookie is not overwritten to `openid` after refresh.
- **JWT extraction**: The openIdJwt/solidJwt strategy reads the JWT from `Authorization: Bearer` first, then from the `openid_id_token` cookie, so the first request after redirect can authenticate before the frontend sets the header. We set the `openid_id_token` cookie when storing tokens in session so that fallback works.

### Access Control (ACL)
- Uses manual ACL Turtle format for permission management
- Grants public read access for shared conversations while preserving owner permissions
- Applies `acl:default` on containers to ensure new resources inherit permissions
- Owner retains Write, Append, and Control permissions when sharing
- Properly removes public access when share is deleted

## Future Improvements

1. **User Storage Selection**
   - Allow users to select their storage Pod (currently uses default Pod URL)
   - Location: `api/server/services/SolidStorage.js:1619`
   - Priority: Low (can be implemented after initial PR)

2. **RDF Parsing Enhancement**
   - Use RDF object mapper to parse Turtle format instead of regex patterns
   - Location: `api/server/services/SolidStorage.js:1659`
   - Priority: Low (current regex parsing works but could be more robust)


## Files Modified
- `api/server/services/SolidStorage.js` (NEW) - Core Solid Pod operations; schema-aligned: accepts full document from model layer, only adds message refs + timestamps + merge with existing for partial updates (no custom document content)
- `api/server/utils/isSolidUser.js` (NEW) - Shared helper to detect Solid login (`provider === 'solid'`), used across models, routes, and middleware (DRY)
- `api/models/Message.js` - Integrated Solid storage; builds full message document (user, createdAt, updatedAt) and passes to SolidStorage; MongoDB path for non-Solid users only (no fallback for Solid)
- `api/models/Conversation.js` - Integrated Solid storage; builds full conversation document and passes to SolidStorage; no MongoDB fallback for Solid users (return null/rethrow on Solid failure); passes `previousConversationId` when renaming
- `api/server/services/Config/solidOpenId.js` - getSolidOpenIdProviders (SOLID_OPENID_PROVIDERS only); getSolidOpenIdProvidersForJwt (includes synthetic Local CSS when only SOLID_OPENID_CUSTOM_CLIENT_ID); getSolidOpenIdProviderByIssuer
- `api/server/services/ensureSolidJwt.js` (NEW) - Ensures solidJwt strategy registered at startup or lazily; uses getSolidOpenIdProvidersForJwt
- `api/server/middleware/openIdAuthHelpers.js` (NEW) - Shared sendStrategyNotRegistered503 for requireJwtAuth and optionalJwtAuth (DRY)
- `api/server/routes/oauth.js` - OAuth handler stores OpenID/Solid tokens via setOpenIDAuthTokens; startBaseStructureAfterLogin for Solid
- `api/server/services/AuthService.js` - setOpenIDAuthTokens: store access/id/refresh in session; set openid_id_token cookie when using session (for first-request auth); set token_provider cookie from req.user?.provider; refresh-token cookie when present
- `api/server/index.js` - Session middleware ordering; /solid-client-id endpoint for dynamic client metadata
- `api/server/controllers/AuthController.js` - performOpenIDRefresh accepts tokenProvider param; sets req.user and user.provider before setOpenIDAuthTokens so token_provider cookie preserved on refresh; session fallback when no refresh token; Solid vs openid by token_provider
- `api/server/middleware/requireJwtAuth.js` - Use solidJwt when token_provider is solid, openidJwt when openid; lazy solidJwt registration; sendStrategyNotRegistered503 from openIdAuthHelpers
- `api/server/middleware/optionalJwtAuth.js` - Same strategy selection and 503 helper as requireJwtAuth
- `api/strategies/SolidOpenidStrategy.js` - verifySolidUser return includes provider: 'solid'; prompt=consent for refresh token; SOLID_OPENID_* env; register as 'solid'
- `api/strategies/openIdJwtStrategy.js` - jwtFromRequest: Authorization Bearer then openid_id_token cookie; used by solidJwt and openidJwt
- `api/server/controllers/auth/solidOpenIdDynamic.js` - startSolidOpenIdFlow, handleSolidOpenIdCallback (multi-issuer with PKCE)
- `api/server/middleware/validate/convoAccess.js` - Solid storage support for conversation access validation
- `api/server/middleware/buildEndpointOption.js` - Uses storage-agnostic `getConvo(req.user.id, conversationId, req)` to fill missing model (no Solid-specific logic)
- `api/server/middleware/validateMessageReq.js` - Solid storage validation; no MongoDB fallback for Solid users (404 on Solid failure)
- `api/server/socialLogins.js` - Solid configured from getSolidOpenIdProvidersForJwt(); configureSolidOpenIdFromProviders (session + solidJwt); registerSolidJwtFromProviders; ensureSolidJwtFromProvidersOnce
- `api/server/routes/config.js` - `openidLoginEnabled: isOpenIdEnabled` only so Solid-only shows one button (per PR review)
- `api/server/routes/messages.js` - Solid message reads return 503 on Solid failure (no MongoDB fallback)
- `api/server/services/Endpoints/agents/initialize.js` - Enhanced model discovery from request body and endpointOption
- `packages/data-provider/src/createPayload.ts` - Added normalization for Solid conversation objects and fallback handling
- `api/server/services/SolidStorage.js` - Schema-aligned: `saveMessageToSolid` accepts full message document; `saveConvoToSolid` accepts full convo document, merges with existing Pod conversation to preserve title (and other fields) on partial updates
- `api/server/utils/import/fork.js` - Added Solid storage support to `duplicateConversation` function
- `api/server/routes/convos.js` - Updated duplicate and delete endpoints to pass `req` for Solid storage support
- `api/server/services/SolidStorage.js` - Added `isArchived` field support in `saveConvoToSolid` and `getConvosByCursorFromSolid` for archive functionality
- `api/server/services/SolidStorage.js` - Added share functionality: `setPublicAccessForShare`, `removePublicAccessForShare`, `getSharedMessagesFromSolid`, and ACL helper functions (`createPublicAcl`, `updateAclWithPublicAccess`, `grantPublicReadAccess`, `removePublicReadAccess`)
- `packages/data-schemas/src/methods/share.ts` - Updated `createSharedLink`, `getSharedMessages`, `deleteSharedLink`, and `deleteConvoSharedLink` to support Solid storage; uses inline require() for SolidStorage/isSolidUser to avoid circular dependency with data-schemas
- `packages/data-schemas/src/schema/share.ts` - Added `podUrl` field to `ISharedLink` schema
- `packages/data-schemas/src/types/share.ts` - Added `podUrl` field to `ISharedLink` interface
- `api/server/routes/share.js` - Updated share routes to pass `req` object for Solid storage support
- `api/strategies/openidStrategy.js` - Generic OpenID strategy for non-Solid OpenID providers
- `api/strategies/index.js` - Exported setupSolidOpenIdFromProvider, getSolidOpenIdConfig, verifySolidUser (dynamic flow; setupSolidOpenId deprecated)
- `api/server/routes/config.js` - openidLoginEnabled: isOpenIdEnabled only; Solid config (solidLoginEnabled, solidLabel, solidImageUrl, solidAutoRedirect)
- `client/src/components/Auth/SocialLoginRender.tsx` - Added Solid button component with SolidIcon
- `packages/client/src/svgs/SolidIcon.tsx` - New Solid icon component for authentication UI
- `packages/client/src/svgs/index.ts` - Exported SolidIcon
- `packages/data-provider/src/config.ts` - Added Solid configuration fields to `TStartupConfig` type

## Dependencies Added
- `@inrupt/solid-client@^1.30.2` - Solid Pod client library

## Environment Variables

### Solid Authentication (SOLID_OPENID_*)
Solid login is configured dynamically via `SOLID_OPENID_PROVIDERS` (JSON array of issuers). The following are used:

- `SOLID_OPENID_PROVIDERS` - **Required.** JSON array; each item: `issuer`, `clientId`, optional `clientSecret`, `scope`, `label`
- `SOLID_OPENID_CLIENT_ID` - Optional; used when your client_id document URL is not `DOMAIN_SERVER/solid-client-id`
- `SOLID_OPENID_SESSION_SECRET` - Secret key for session management (recommended when using Solid)
- `SOLID_OPENID_SCOPE` - Default scope (e.g. `"openid webid offline_access"`)
- `SOLID_OPENID_CALLBACK_URL` - OAuth callback path (typically `/oauth/openid/callback`)

### Optional Solid Configuration
- `SOLID_OPENID_CUSTOM_CLIENT_ID` - Optional; when set, allows logging in with any allowed issuer (e.g. user picks "Local CSS" from modal) using this client id; used by getSolidOpenIdProviderByIssuer and getSolidOpenIdProvidersForJwt when SOLID_OPENID_PROVIDERS is empty
- `SOLID_OPENID_BUTTON_LABEL` - Custom label for the Solid login button (default: "Continue with Solid")
- `SOLID_OPENID_IMAGE_URL` - Custom icon URL for the Solid login button
- `SOLID_OPENID_AUTO_REDIRECT` - Enable automatic redirect to Solid provider on login page

### Generic OpenID Authentication (OPENID_*)
The following environment variables are used for the generic "Login with OpenID" button:

- `OPENID_CLIENT_ID` - OAuth client ID for generic OpenID authentication
- `OPENID_CLIENT_SECRET` - OAuth client secret for generic OpenID authentication
- `OPENID_ISSUER` - OpenID provider URL
- `OPENID_SCOPE` - OAuth scopes
- `OPENID_SESSION_SECRET` - Secret key for session management
- `OPENID_CALLBACK_URL` - OAuth callback URL (typically `/oauth/openid/callback`)
- `OPENID_BUTTON_LABEL` - Custom label for the OpenID login button (default: "Continue with OpenID")
- `OPENID_IMAGE_URL` - Custom icon URL for the OpenID login button
- `OPENID_AUTO_REDIRECT` - Enable automatic redirect to OpenID provider on login page

### Solid Storage
- Storage is chosen per user: **Solid Pod** for users who logged in with "Continue with Solid" (`provider === 'solid'`); **MongoDB** for everyone else. No environment variable is required.

### Imports (top-level vs inline)
- **API code** (Conversation.js, Message.js, buildEndpointOption.js, validateMessageReq.js, messages.js, convos.js, fork.js): SolidStorage and isSolidUser are required at **top level** for clarity and tooling (per PR review). buildEndpointOption.js now uses only `getConvo` from `~/models` (no SolidStorage/isSolidUser).
- **packages/data-schemas share.ts**: SolidStorage and isSolidUser use **inline** `require()` inside the functions that need them, to avoid a circular dependency (data-schemas ← SolidStorage ← data-schemas for `logger`). Top-level require there caused `logger` to be undefined at load time and backend crash.

---

**Report Date**: February 27, 2026


