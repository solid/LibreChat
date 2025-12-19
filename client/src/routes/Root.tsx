import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import type { ContextType } from '~/common';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { TermsAndConditionsModal } from '~/components/ui';
import { Nav, MobileNav } from '~/components/Nav';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';
import { Spinner } from '@librechat/client';
import store from '~/store';

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const [navVisible, setNavVisible] = useState(() => {
    const savedNavVisible = localStorage.getItem('navVisible');
    return savedNavVisible !== null ? JSON.parse(savedNavVisible) : true;
  });

  const { isAuthenticated, logout } = useAuthContext();
  const recoilUser = useRecoilValue(store.user);
  
  // Consider user authenticated if either AuthContext says so OR Recoil has user
  // (Recoil is set immediately, AuthContext is debounced)
  const effectivelyAuthenticated = isAuthenticated || !!recoilUser;

  // Global health check - runs once per authenticated session
  useHealthCheck(effectivelyAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated: effectivelyAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated: effectivelyAuthenticated });
  const fileMap = useFileMap({ isAuthenticated: effectivelyAuthenticated });

  const { data: config } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: effectivelyAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });

  useSearchEnabled(effectivelyAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  // Check if we have Solid OIDC callback params or auth in progress
  const checkSolidAuth = () => {
    if (typeof window !== 'undefined') {
      const authInProgress = sessionStorage.getItem('solid_auth_in_progress') === 'true';
      if (authInProgress) {
        return true;
      }
    }
    // Fallback to URL params
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has('code') && urlParams.has('state');
  };
  
  const hasSolidCallback = checkSolidAuth();
  
  // If auth is in progress, render a loading state instead of null
  // This prevents React Router from thinking the route doesn't match
  if (!effectivelyAuthenticated && hasSolidCallback) {
    return (
      <div className="flex h-screen items-center justify-center" aria-live="polite" role="status">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8 text-green-500" />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Authenticating with Solid...
          </p>
        </div>
      </div>
    );
  }
  
  if (!effectivelyAuthenticated && !hasSolidCallback) {
    return null;
  }

  return (
    <SetConvoProvider>
      <FileMapContext.Provider value={fileMap}>
        <AssistantsMapContext.Provider value={assistantsMap}>
          <AgentsMapContext.Provider value={agentsMap}>
            <PromptGroupsProvider>
              <Banner onHeightChange={setBannerHeight} />
              <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px)` }}>
                <div className="relative z-0 flex h-full w-full overflow-hidden">
                  <Nav navVisible={navVisible} setNavVisible={setNavVisible} />
                  <div className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden">
                    <MobileNav navVisible={navVisible} setNavVisible={setNavVisible} />
                    <Outlet context={{ navVisible, setNavVisible } satisfies ContextType} />
                  </div>
                </div>
              </div>
            </PromptGroupsProvider>
          </AgentsMapContext.Provider>
          {config?.interface?.termsOfService?.modalAcceptance === true && (
            <TermsAndConditionsModal
              open={showTerms}
              onOpenChange={setShowTerms}
              onAccept={handleAcceptTerms}
              onDecline={handleDeclineTerms}
              title={config.interface.termsOfService.modalTitle}
              modalContent={config.interface.termsOfService.modalContent}
            />
          )}
        </AssistantsMapContext.Provider>
      </FileMapContext.Provider>
    </SetConvoProvider>
  );
}
