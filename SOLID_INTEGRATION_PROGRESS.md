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

### 7. Feature Flag Implementation
- **Status**: Complete
- **Details**:
  - Added `USE_SOLID_STORAGE` environment variable
  - Integrated Solid storage functions into `Message.js` and `Conversation.js` models
  - Maintains backward compatibility with MongoDB
  - Original MongoDB code preserved (commented) for rollback capability

### 8. Conversation Access Validation
- **Status**: Complete
- **Details**:
  - Updated `validateConvoAccess` middleware to check Solid storage
  - Modified `searchConversation` to query Solid Pod when `USE_SOLID_STORAGE` is enabled
  - Ensures users can only access their own conversations from Solid Pod
  - Maintains MongoDB fallback for non-Solid users

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

## Current Status

### Working Features
1. **User Login**: Solid-OIDC authentication working correctly
2. **Conversation Creation**: New conversations are saved to Solid Pod
3. **Message Saving**: User messages and AI responses are saved to Solid Pod
4. **Data Retrieval**: Conversations and messages can be read from Pod
5. **Container Structure**: Proper directory structure created automatically
6. **Conversation Continuation**: Users can send multiple messages in the same conversation
7. **Model Persistence**: Model and endpoint information is correctly stored and retrieved
8. **Access Control**: Conversation access validation works for Solid storage users

### Known Issues 🔧
1. **Title Retrieval on Page Refresh**
   - **Issue**: When the page is refreshed, conversation titles revert to "untitled" instead of loading the saved title from Solid Pod
   - **Impact**: Users lose visual context of their conversations after refresh
   - **Status**: To be fixed
   - **Priority**: High

2. **Conversation Menu Options**
   - **Issue**: Share, Rename, Duplicate, Archive, and Delete options need to be implemented for Solid storage
   - **Impact**: Users cannot manage their conversations stored in Solid Pod
   - **Status**: Not yet implemented
   - **Priority**: High

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

## Next Steps

1. **Conversation Menu Options Implementation**
   - Implement Share functionality for Solid storage conversations
   - Implement Rename functionality (update conversation title in Solid Pod)
   - Implement Duplicate functionality (create copy in Solid Pod)
   - Implement Archive functionality (mark as archived in Solid Pod)
   - Implement Delete functionality (remove from Solid Pod)
   - Ensure all operations work seamlessly with Solid storage backend

2. **Fix Title Retrieval on Page Refresh**
   - Issue: When page is refreshed, conversation titles revert to "untitled" instead of loading from Solid Pod
   - Root Cause: Title not being properly retrieved/loaded from Solid storage on initial page load
   - Priority: High (affects user experience)


## Files Modified
- `api/server/services/SolidStorage.js` (NEW) - Core Solid Pod operations
- `api/models/Message.js` - Integrated Solid storage
- `api/models/Conversation.js` - Integrated Solid storage, updated `searchConversation` for Solid support
- `api/server/routes/oauth.js` - Token logging and storage
- `api/server/services/AuthService.js` - Token management
- `api/server/index.js` - Session middleware ordering
- `api/server/controllers/AuthController.js` - Refresh token handling
- `api/server/middleware/validate/convoAccess.js` - Added Solid storage support for conversation access validation
- `api/server/middleware/buildEndpointOption.js` - Added model extraction from Solid storage when missing
- `api/server/services/Endpoints/agents/initialize.js` - Enhanced model discovery from request body and endpointOption
- `packages/data-provider/src/createPayload.ts` - Added normalization for Solid conversation objects and fallback handling

## Dependencies Added
- `@inrupt/solid-client@^1.30.2` - Solid Pod client library

---

**Report Date**: February 2, 2026  

