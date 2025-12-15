import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthContext } from '~/hooks';

export default function useAuthRedirect() {
  const { user, isAuthenticated } = useAuthContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Check if we have Solid OIDC callback param
    // Use sessionStorage flag (set by SolidAuthProvider) + URL params for reliability
    const checkCallback = () => {
      if (typeof window !== 'undefined') {
        const authInProgress = sessionStorage.getItem('solid_auth_in_progress') === 'true';
        if (authInProgress) {
          return true;
        }
      }
      // Fallback to URL params
      if (typeof window !== 'undefined') {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('code') && urlParams.has('state')) {
          return true;
        }
      }
      return searchParams.has('code') && searchParams.has('state');
    };
    
    const hasSolidCallback = checkCallback();
    
    if (hasSolidCallback) {
      return; 
    }
    
    const timeout = setTimeout(() => {

      const stillHasCallback = checkCallback();
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
