import { useState, useEffect } from 'react';
import { useSolidAuth } from '@ldo/solid-react';
import { useSearchParams } from 'react-router-dom';
import {
  GoogleIcon,
  FacebookIcon,
  OpenIDIcon,
  GithubIcon,
  DiscordIcon,
  AppleIcon,
  SamlIcon,
  SolidIcon,
} from '@librechat/client';

import SocialButton from './SocialButton';
import SolidProviderModal from './SolidProviderModal';

import { useLocalize } from '~/hooks';

import { TStartupConfig } from 'librechat-data-provider';

function SocialLoginRender({
  startupConfig,
}: {
  startupConfig: TStartupConfig | null | undefined;
}) {
  const localize = useLocalize();
  const [isSolidModalOpen, setIsSolidModalOpen] = useState(false);
  const { login, session } = useSolidAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  // Check if we're processing an OIDC callback
  const hasOidcCallback = searchParams.has('code') && searchParams.has('state');
  
  // Don't show modal or allow login if we're processing a callback or already logged in
  useEffect(() => {
    if (hasOidcCallback || session.isLoggedIn) {
      setIsSolidModalOpen(false);
    }
  }, [hasOidcCallback, session.isLoggedIn]);

  const handleSolidClick = () => {
    setIsSolidModalOpen(true);
  };

  const handleProviderSelect = async (issuer: string) => {
    // Don't initiate login if we're already processing a callback
    if (hasOidcCallback || session.isLoggedIn) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const redirectUrl = `${window.location.origin}/c/new`;
      await login(issuer, { redirectUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setIsLoading(false);
    }
  };

  if (!startupConfig) {
    return null;
  }

  const providerComponents = {
    discord: startupConfig.discordLoginEnabled && (
      <SocialButton
        key="discord"
        enabled={startupConfig.discordLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="discord"
        Icon={DiscordIcon}
        label={localize('com_auth_discord_login')}
        id="discord"
      />
    ),
    facebook: startupConfig.facebookLoginEnabled && (
      <SocialButton
        key="facebook"
        enabled={startupConfig.facebookLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="facebook"
        Icon={FacebookIcon}
        label={localize('com_auth_facebook_login')}
        id="facebook"
      />
    ),
    github: startupConfig.githubLoginEnabled && (
      <SocialButton
        key="github"
        enabled={startupConfig.githubLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="github"
        Icon={GithubIcon}
        label={localize('com_auth_github_login')}
        id="github"
      />
    ),
    google: startupConfig.googleLoginEnabled && (
      <SocialButton
        key="google"
        enabled={startupConfig.googleLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="google"
        Icon={GoogleIcon}
        label={localize('com_auth_google_login')}
        id="google"
      />
    ),
    apple: startupConfig.appleLoginEnabled && (
      <SocialButton
        key="apple"
        enabled={startupConfig.appleLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="apple"
        Icon={AppleIcon}
        label={localize('com_auth_apple_login')}
        id="apple"
      />
    ),
    openid: startupConfig.openidLoginEnabled && (
      <SocialButton
        key="openid"
        enabled={startupConfig.openidLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="openid"
        Icon={() =>
          startupConfig.openidImageUrl ? (
            <img src={startupConfig.openidImageUrl} alt="OpenID Logo" className="h-5 w-5" />
          ) : (
            <OpenIDIcon />
          )
        }
        label={startupConfig.openidLabel}
        id="openid"
      />
    ),
    saml: startupConfig.samlLoginEnabled && (
      <SocialButton
        key="saml"
        enabled={startupConfig.samlLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="saml"
        Icon={() =>
          startupConfig.samlImageUrl ? (
            <img src={startupConfig.samlImageUrl} alt="SAML Logo" className="h-5 w-5" />
          ) : (
            <SamlIcon />
          )
        }
        label={startupConfig.samlLabel ? startupConfig.samlLabel : localize('com_auth_saml_login')}
        id="saml"
      />
    ),
    solid: (
      <SocialButton
        key="solid"
        enabled={true}
        Icon={SolidIcon}
        label={localize('com_auth_solid_login')}
        id="solid"
        onClick={handleSolidClick}
      />
    ),
  };

  return (
    startupConfig.socialLoginEnabled && (
      <>
        {startupConfig.emailLoginEnabled && (
          <>
            <div className="relative mt-6 flex w-full items-center justify-center border border-t border-gray-300 uppercase dark:border-gray-600">
              <div className="absolute bg-white px-3 text-xs text-black dark:bg-gray-900 dark:text-white">
                Or
              </div>
            </div>
            <div className="mt-8" />
          </>
        )}
        <div className="mt-2">
          {providerComponents.solid}
          {startupConfig.socialLogins?.map((provider) => {
            // Skip 'solid' since it's already rendered above
            if (provider === 'solid') {
              return null;
            }
            return providerComponents[provider] || null;
          })}
        </div>
        <SolidProviderModal
          open={isSolidModalOpen}
          onOpenChange={setIsSolidModalOpen}
          onProviderSelect={handleProviderSelect}
          isLoading={isLoading}
          error={error}
        />
      </>
    )
  );
}

export default SocialLoginRender;
