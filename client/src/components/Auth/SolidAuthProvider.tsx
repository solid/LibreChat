import { ReactNode } from 'react';
import { BrowserSolidLdoProvider } from '@ldo/solid-react';

/**
 * Solid LDO Provider Component
 *
 * This provider wraps the application with BrowserSolidLdoProvider from @ldo/solid-react,
 * which enables Linked Data Objects (LDO) functionality for interacting with Solid Pods.
 *
 * Authentication Flow:
 * - Solid OIDC authentication is now handled entirely server-side via /oauth/solid
 * - The server performs proper token verification and issues JWT tokens
 * - This provider is only needed for Pod data access (useSolidStorage, useLdo, etc.)
 *
 * The @ldo/solid-react library will automatically restore Solid sessions from localStorage
 * if the user has previously logged in, enabling authenticated Pod access.
 */
export default function SolidAuthProvider({ children }: { children: ReactNode }) {
  return (
    <BrowserSolidLdoProvider>
      {children}
    </BrowserSolidLdoProvider>
  );
}
