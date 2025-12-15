import { useCallback, useState } from 'react';

/**
 * Solid Authentication Hook
 * Handles Solid OIDC authentication flow initiation
 * 
 * The actual authentication is handled by SolidAuthProvider component
 * which uses @ldo/solid-react to manage the OIDC flow.
 */
export function useSolidAuthFlow() {
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSolidLogin = useCallback(
    async (issuer: string) => {
      setIsAuthenticating(true);
      setError(null);

      try {
        sessionStorage.setItem('solid_issuer', issuer);
        sessionStorage.setItem('solid_redirect', '/c/new');
        
        // Dispatch custom event to trigger login check in SolidAuthProvider
        window.dispatchEvent(new CustomEvent('solid-issuer-stored', { detail: { issuer } }));
        
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
        setIsAuthenticating(false);
      }
    },
    [],
  );

  return {
    handleSolidLogin,
    isAuthenticating,
    error,
  };
}

