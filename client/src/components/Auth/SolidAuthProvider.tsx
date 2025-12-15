import { useEffect, ReactNode, useRef, useState } from 'react';
import { BrowserSolidLdoProvider, useSolidAuth } from '@ldo/solid-react';
import { setTokenHeader } from 'librechat-data-provider';
import { useSolidAuthMutation } from '~/data-provider';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { Spinner } from '@librechat/client';
import store from '~/store';

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
  const hasRedirected = useRef(false);
  const isRedirecting = useRef(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const SOLID_AUTH_REDIRECTED_KEY = 'solid_auth_redirected';
  const SOLID_AUTH_IN_PROGRESS_KEY = 'solid_auth_in_progress'; 
  
  if (typeof window !== 'undefined') {
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallbackParams = urlParams.has('code') && urlParams.has('state');
    if (hasCallbackParams && !sessionStorage.getItem(SOLID_AUTH_IN_PROGRESS_KEY)) {
      sessionStorage.setItem(SOLID_AUTH_IN_PROGRESS_KEY, 'true');
    }
  }
  
  // Initialize refs from sessionStorage on mount
  useEffect(() => {
    const wasRedirected = sessionStorage.getItem(SOLID_AUTH_REDIRECTED_KEY) === 'true';
    if (wasRedirected) {
      hasRedirected.current = true;
    }
  }, []);

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
      
      // Clean URL params (like Google OAuth does)
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('code') || urlParams.has('state') || urlParams.has('iss')) {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
      
      setIsAuthenticating(false);
      
      //  Mark as redirected BEFORE redirecting to prevent loops
      if (hasRedirected.current) {
        return;
      }
      
      hasRedirected.current = true;
      hasCalledBackend.current = true;

      sessionStorage.setItem(SOLID_AUTH_REDIRECTED_KEY, 'true');
      // Clear the "in progress" flag since auth is complete
      sessionStorage.removeItem(SOLID_AUTH_IN_PROGRESS_KEY);
      
      // Clean up @ldo/solid-react's localStorage to prevent it from re-processing
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('oidc.') || key.startsWith('solidClientAuthn') || key.startsWith('solidClientAuthenticationUser'))) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
      } catch (err) {
        // Silently fail if localStorage cleanup fails
      }
      
      // Prevent multiple redirects
      if (isRedirecting.current) {
        return;
      }
      
      isRedirecting.current = true;
      
      // If we're already on /c/new, just clean the URL params and stay there
      // Otherwise, redirect to /c/new
      if (window.location.pathname.includes('/c/')) {
        if (!window.location.pathname.includes('/c/new')) {
          window.location.replace('/c/new');
        }
      } else {
        window.location.replace('/c/new');
      }
    },
    onError: (error) => {
      setIsAuthenticating(false);
      hasCalledBackend.current = false;
      // Clear the "in progress" flag on error so user can try again
      sessionStorage.removeItem(SOLID_AUTH_IN_PROGRESS_KEY);
    },
  });

  // Handle Solid authentication 
  useEffect(() => {
    // This flag tells AuthContext that auth is in progress, even after URL params are cleaned
    const initialUrlParams = new URLSearchParams(window.location.search);
    const initialHasCallbackParams = initialUrlParams.has('code') || initialUrlParams.has('state');
    
    if (initialHasCallbackParams && !sessionStorage.getItem(SOLID_AUTH_IN_PROGRESS_KEY)) {
      sessionStorage.setItem(SOLID_AUTH_IN_PROGRESS_KEY, 'true');
    }

    // Check sessionStorage on every render (in case it was set by another instance)
    const wasRedirectedInStorage = sessionStorage.getItem(SOLID_AUTH_REDIRECTED_KEY) === 'true';
    if (wasRedirectedInStorage && !hasRedirected.current) {
      hasRedirected.current = true;
    }

    //  Don't process if we've already redirected or if user is already authenticated
    if (hasRedirected.current || wasRedirectedInStorage || currentUser) {
      // Clean callback params immediately to prevent @ldo/solid-react from re-processing
      if (initialHasCallbackParams) {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
      
      return;
    }

    const isOnLoginPage = window.location.pathname.includes('/login');
    const isOnChatPage = window.location.pathname.includes('/c/');
    
    if (!isOnLoginPage && !isOnChatPage) {
      return;
    }

    // Check if we have auth cookies (means backend already authenticated us)
    const hasAuthCookie = document.cookie.split(';').some(cookie => cookie.trim().startsWith('refreshToken='));
    if (hasAuthCookie && !currentUser && !isRedirecting.current) {
      // Backend authenticated but user state not set yet - redirect to chat
      hasRedirected.current = true;
      isRedirecting.current = true;
      sessionStorage.setItem(SOLID_AUTH_REDIRECTED_KEY, 'true');
      setTimeout(() => {
        window.location.replace('/c/new');
      }, 0);
      return;
    }

    // Once session is logged in, call backend
    // Note: @ldo/solid-react may remove callback params before session.isLoggedIn becomes true
    // So we check session.isLoggedIn first, not the callback params
    if (session.isLoggedIn && session.webId) {
      // Prevent duplicate calls
      if (hasCalledBackend.current || solidAuthMutation.isLoading) {
        return;
      }

      hasCalledBackend.current = true;
      solidAuthMutation.mutate({ webId: session.webId });
    }
  }, [session.isLoggedIn, session.webId, currentUser, solidAuthMutation.isLoading]);

  // Show loading overlay during authentication
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const hasCallbackParams = urlParams && (urlParams.has('code') || urlParams.has('state'));
  const isOnLoginPage = typeof window !== 'undefined' && window.location.pathname.includes('/login');
  
  // Show loading if we have callback params and are either:
  // 1. Currently authenticating (mutation in progress)
  // 2. Session is logged in (waiting for backend to authenticate)
  // 3. On login page with callback params (app redirected us here during auth)
  const showLoading = hasCallbackParams && (
    isAuthenticating || 
    solidAuthMutation.isLoading || 
    session.isLoggedIn || 
    (isOnLoginPage && !currentUser)
  );
  
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
