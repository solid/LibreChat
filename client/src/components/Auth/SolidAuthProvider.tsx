import { useEffect, ReactNode, useRef, useState } from 'react';
import { BrowserSolidLdoProvider, useSolidAuth } from '@ldo/solid-react';
import { setTokenHeader } from 'librechat-data-provider';
import { useSolidAuthMutation } from '~/data-provider';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { Spinner } from '@librechat/client';
import store from '~/store';

const SOLID_AUTH_IN_PROGRESS_KEY = 'solid_auth_in_progress';

/**
 * Solid Authentication Provider Component
 *
 * Handles Solid OIDC authentication flow:
 * 1. User selects provider and logs in via @ldo/solid-react
 * 2. Once session is logged in, call backend to authenticate
 * 3. Backend sets cookies (refreshToken, token_provider)
 * 4. Redirect to chat page
 *
 */
function SolidAuthInner({ children }: { children: ReactNode }) {
  const { session } = useSolidAuth();
  const setUser = useSetRecoilState(store.user);
  const currentUser = useRecoilValue(store.user);
  const hasCalledBackend = useRef(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Set auth in progress flag if we have callback params (for AuthContext to know)
  if (typeof window !== 'undefined') {
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallbackParams = urlParams.has('code') && urlParams.has('state');
    if (hasCallbackParams && !sessionStorage.getItem(SOLID_AUTH_IN_PROGRESS_KEY)) {
      sessionStorage.setItem(SOLID_AUTH_IN_PROGRESS_KEY, 'true');
    }
  }

  // Initialize refs from sessionStorage on mount
  useEffect(() => {
    // Clear the in-progress flag once user is confirmed logged in
    // This ensures Root.tsx shows loading state until AuthContext.isAuthenticated is true
    if (currentUser && sessionStorage.getItem(SOLID_AUTH_IN_PROGRESS_KEY)) {
      sessionStorage.removeItem(SOLID_AUTH_IN_PROGRESS_KEY);
    }
  }, [session.isLoggedIn, session.webId, currentUser]);

  const solidAuthMutation = useSolidAuthMutation({
    onMutate: () => {
      setIsAuthenticating(true);
    },
    onSuccess: (data) => {
      const { user, token } = data;

      if (!token) {
        setIsAuthenticating(false);
        hasCalledBackend.current = false;
        return;
      }

      // Set user in Recoil state
      setUser(user);

      // Set token header for API requests
      setTokenHeader(token);

      // Dispatch tokenRefreshed event so AuthContext sets isAuthenticated = true
      // This is the same event that silentRefresh uses
      window.dispatchEvent(new CustomEvent('tokenRefreshed', { detail: token }));

      setIsAuthenticating(false);

      // Clean URL params
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('code') || urlParams.has('state') || urlParams.has('iss')) {
        window.history.replaceState({}, '', window.location.pathname);
      }

      // If not on a chat page, navigate there
      if (!window.location.pathname.includes('/c/')) {
        window.location.href = '/c/new';
      }
    },
    onError: (error) => {
      setIsAuthenticating(false);
      sessionStorage.removeItem(SOLID_AUTH_IN_PROGRESS_KEY);
      
      // Clean up URL params even on error to prevent infinite loop
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('code') || urlParams.has('state') || urlParams.has('iss')) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      
      // Reset the ref so user can try again if needed
      hasCalledBackend.current = false;
    },
  });

  // Handle Solid authentication
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallbackParams = urlParams.has('code') || urlParams.has('state');

    // If user is already logged in to the app, nothing to do
    if (currentUser) {
      // Clean up URL params if they're still there
      if (hasCallbackParams) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      return;
    }

    // If we've already called the backend in this session, don't call again
    if (hasCalledBackend.current || solidAuthMutation.isLoading) {
      return;
    }

    // Once @ldo/solid-react has processed the callback and session is logged in,
    // Clean up URL params so backend call can proceed
    if (session.isLoggedIn && session.webId && hasCallbackParams) {
      
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Call backend when: Solid session is logged in (params are cleaned up above)
    if (session.isLoggedIn && session.webId) {
      hasCalledBackend.current = true;
      solidAuthMutation.mutate({ webId: session.webId });
    }
  }, [session.isLoggedIn, session.webId, currentUser]);

  // Show loading overlay during Solid authentication
  // Show when: we're authenticating OR mutation is loading, AND user isn't logged in yet
  const showLoading = !currentUser && (isAuthenticating || solidAuthMutation.isLoading);

  return (
    <>
      {showLoading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-lg bg-white p-8 shadow-xl dark:bg-gray-800">
            <Spinner className="h-8 w-8 text-green-500" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Authenticating with Solid...
            </p>
          </div>
        </div>
      )}
      {children}
    </>
  );
}

export default function SolidAuthProvider({ children }: { children: ReactNode }) {
  return (
    <BrowserSolidLdoProvider>
      <SolidAuthInner>{children}</SolidAuthInner>
    </BrowserSolidLdoProvider>
  );
}
