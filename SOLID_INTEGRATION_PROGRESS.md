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
  - Fixed model extraction in `buildEndpointOption` middleware to load from Solid when missing

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
  - Titles persist correctly after page refresh
  - `saveConvo` correctly identifies Solid users before saving to Solid Pod
  - `saveConvoToSolid` merges updates with existing conversation data to prevent data loss

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
- `api/server/services/SolidStorage.js` (NEW) - Core Solid Pod operations
- `api/server/utils/isSolidUser.js` (NEW) - Shared helper to detect Solid login (`provider === 'solid'`), used across models, routes, and middleware (DRY)
- `api/models/Message.js` - Integrated Solid storage; MongoDB path for non-Solid users only (no fallback for Solid)
- `api/models/Conversation.js` - Integrated Solid storage; no MongoDB fallback for Solid users (return null/rethrow on Solid failure)
- `api/server/routes/oauth.js` - Token logging and storage
- `api/server/services/AuthService.js` - Token management
- `api/server/index.js` - Session middleware ordering
- `api/server/controllers/AuthController.js` - Refresh token handling
- `api/server/middleware/validate/convoAccess.js` - Added Solid storage support for conversation access validation
- `api/server/middleware/buildEndpointOption.js` - Added model extraction from Solid storage when missing; uses shared `isSolidUser`
- `api/server/middleware/validateMessageReq.js` - Solid storage validation; no MongoDB fallback for Solid users (404 on Solid failure)
- `api/server/routes/messages.js` - Solid message reads return 503 on Solid failure (no MongoDB fallback)
- `api/server/services/Endpoints/agents/initialize.js` - Enhanced model discovery from request body and endpointOption
- `packages/data-provider/src/createPayload.ts` - Added normalization for Solid conversation objects and fallback handling
- `api/models/Conversation.js` - Fixed `saveConvo` to check for Solid users before saving to Solid Pod, added Solid storage support to `deleteConvos`
- `api/server/services/SolidStorage.js` - Enhanced `saveConvoToSolid` to merge updates with existing conversation data, improved message deletion logging
- `api/server/utils/import/fork.js` - Added Solid storage support to `duplicateConversation` function
- `api/server/routes/convos.js` - Updated duplicate and delete endpoints to pass `req` for Solid storage support
- `api/server/services/SolidStorage.js` - Added `isArchived` field support in `saveConvoToSolid` and `getConvosByCursorFromSolid` for archive functionality
- `api/server/services/SolidStorage.js` - Added share functionality: `setPublicAccessForShare`, `removePublicAccessForShare`, `getSharedMessagesFromSolid`, and ACL helper functions (`createPublicAcl`, `updateAclWithPublicAccess`, `grantPublicReadAccess`, `removePublicReadAccess`)
- `packages/data-schemas/src/methods/share.ts` - Updated `createSharedLink`, `getSharedMessages`, `deleteSharedLink`, and `deleteConvoSharedLink` to support Solid storage
- `packages/data-schemas/src/schema/share.ts` - Added `podUrl` field to `ISharedLink` schema
- `packages/data-schemas/src/types/share.ts` - Added `podUrl` field to `ISharedLink` interface
- `api/server/routes/share.js` - Updated share routes to pass `req` object for Solid storage support
- `api/strategies/SolidOpenidStrategy.js` - Updated to use `SOLID_OPENID_*` environment variables and register as 'openid' strategy
- `api/strategies/openidStrategy.js` - Generic OpenID strategy for non-Solid OpenID providers
- `api/strategies/index.js` - Exported both `setupSolidOpenId` and `setupOpenId` functions
- `api/server/socialLogins.js` - Added separate configuration functions for Solid and generic OpenID strategies
- `api/server/routes/config.js` - Added Solid-specific configuration fields (`solidLoginEnabled`, `solidLabel`, `solidImageUrl`, `solidAutoRedirect`)
- `client/src/components/Auth/SocialLoginRender.tsx` - Added Solid button component with SolidIcon
- `packages/client/src/svgs/SolidIcon.tsx` - New Solid icon component for authentication UI
- `packages/client/src/svgs/index.ts` - Exported SolidIcon
- `packages/data-provider/src/config.ts` - Added Solid configuration fields to `TStartupConfig` type

## Dependencies Added
- `@inrupt/solid-client@^1.30.2` - Solid Pod client library

## Environment Variables

### Solid Authentication (SOLID_OPENID_*)
The following environment variables are required for the "Login with Solid" button:

- `SOLID_OPENID_CLIENT_ID` - OAuth client ID for Solid authentication
- `SOLID_OPENID_CLIENT_SECRET` - OAuth client secret for Solid authentication
- `SOLID_OPENID_ISSUER` - Solid Pod provider URL (e.g., `http://localhost:3000/`)
- `SOLID_OPENID_SCOPE` - OAuth scopes (typically `"openid webid"`)
- `SOLID_OPENID_SESSION_SECRET` - Secret key for session management
- `SOLID_OPENID_CALLBACK_URL` - OAuth callback URL (typically `/oauth/openid/callback`)

### Optional Solid Configuration
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

---

**Report Date**: February 11, 2026


