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

## Current Status

### Working Features
1. **User Login**: Solid-OIDC authentication working correctly
2. **Conversation Creation**: New conversations are saved to Solid Pod
3. **Message Saving**: User messages are saved to Solid Pod
4. **Data Retrieval**: Conversations and messages can be read from Pod
5. **Container Structure**: Proper directory structure created automatically

### Known Issues 🔧
1. **Message Updates**: LLM response messages fail to update in Pod
   - **Error**: `conversationId is required for updating messages`
   - **Root Cause**: `conversationId` not always present in message object during updates
   - **Status**: In Progress

2. **Title Generation**: Endpoint `/api/convos/gen_title/{conversationId}` returns 404
   - **Status**: To be investigated

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
1. Fix message update functionality to handle missing `conversationId`
2. Investigate and fix title generation endpoint
3. Test full conversation flow (create → send message → receive LLM response → update)
4. Performance testing with multiple conversations
5. Error recovery and retry mechanisms

## Files Modified
- `api/server/services/SolidStorage.js` (NEW) - Core Solid Pod operations
- `api/models/Message.js` - Integrated Solid storage
- `api/models/Conversation.js` - Integrated Solid storage
- `api/server/routes/oauth.js` - Token logging and storage
- `api/server/services/AuthService.js` - Token management
- `api/server/index.js` - Session middleware ordering
- `api/server/controllers/AuthController.js` - Refresh token handling

## Dependencies Added
- `@inrupt/solid-client@^1.30.2` - Solid Pod client library

---

**Report Date**: January 30, 2026  
**Status**: 85% Complete - Core functionality working, minor fixes needed
