import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthContext } from '~/hooks';

export default function useAuthRedirect() {
  const { user, isAuthenticated } = useAuthContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Check if we have OAuth callback params (code + state)
    // This handles any OAuth provider including Solid
    const hasOAuthCallback = searchParams.has('code') && searchParams.has('state');
    
    if (hasOAuthCallback) {
      // OAuth callback in progress, don't redirect yet
      return; 
    }
    
    const timeout = setTimeout(() => {
      // Re-check for callback params in case they were added
      const urlParams = new URLSearchParams(window.location.search);
      const stillHasCallback = urlParams.has('code') && urlParams.has('state');
      
      if (!isAuthenticated && !stillHasCallback) {
        navigate('/login', { replace: true });
      }
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [isAuthenticated, navigate, searchParams]);

  return {
    user,
    isAuthenticated,
  };
}
