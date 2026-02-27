import { useState } from 'react';
import {
  OGDialog,
  OGDialogTrigger,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  OGDialogDescription,
  OGDialogFooter,
  OGDialogClose,
  Button,
} from '@librechat/client';
import type { TStartupConfig } from 'librechat-data-provider';

import { useLocalize, TranslationKeys } from '~/hooks';

type SolidLoginButtonProps = {
  startupConfig: TStartupConfig;
  label: string;
  Icon: React.ComponentType | (() => React.ReactNode);
};

function isValidIssuerUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  try {
    const u = new URL(t.startsWith('http') ? t : `https://${t}`);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Solid login button that opens an IdP selection modal: URL input + optional provider pills.
 * Redirects to serverDomain + '/oauth/openid?issuer=' + encodeURIComponent(selectedIssuer)
 */
function SolidLoginButton({ startupConfig, label, Icon }: SolidLoginButtonProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [providerUrl, setProviderUrl] = useState('');
  const [selectedOptionIssuer, setSelectedOptionIssuer] = useState<string | null>(null);

  const options = startupConfig.solidIdpOptions ?? [];
  const customEnabled = startupConfig.solidCustomEnabled === true;
  const serverDomain = startupConfig.serverDomain || '';

  const trimmedUrl = providerUrl.trim();
  const effectiveIssuer = trimmedUrl;
  const canContinue =
    serverDomain &&
    !!trimmedUrl &&
    (customEnabled
      ? isValidIssuerUrl(trimmedUrl)
      : options.some((opt) => opt.issuer === trimmedUrl));

  const handleSelectOption = (issuer: string) => {
    setSelectedOptionIssuer(issuer);
    setProviderUrl(issuer);
  };

  const handleContinue = () => {
    if (!canContinue || !effectiveIssuer) return;
    const url = `${serverDomain}/oauth/openid?issuer=${encodeURIComponent(effectiveIssuer)}`;
    window.location.href = url;
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setProviderUrl('');
      setSelectedOptionIssuer(null);
    }
  };

  if (!startupConfig.solidLoginEnabled) {
    return null;
  }

  return (
    <div className="mt-2 flex gap-x-2">
      <OGDialog open={open} onOpenChange={handleOpenChange}>
        <OGDialogTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex w-full items-center space-x-3 rounded-2xl border border-border-light bg-surface-primary px-5 py-3 text-text-primary transition-colors duration-200 hover:bg-surface-tertiary"
            data-testid="solid"
          >
            <Icon />
            <p>{label}</p>
          </button>
        </OGDialogTrigger>
        <OGDialogContent className="max-w-md">
          <OGDialogHeader>
            <OGDialogTitle>
              {localize('com_auth_solid_idp_modal_title' as TranslationKeys)}
            </OGDialogTitle>
            <OGDialogDescription>
              {localize('com_auth_solid_idp_modal_description' as TranslationKeys)}
            </OGDialogDescription>
          </OGDialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label htmlFor="solid-idp-url" className="text-sm font-medium text-text-primary">
                {localize('com_auth_solid_idp_label' as TranslationKeys)}
              </label>
              <input
                id="solid-idp-url"
                type="url"
                placeholder={localize('com_auth_solid_idp_placeholder' as TranslationKeys)}
                value={providerUrl}
                onChange={(e) => {
                  setProviderUrl(e.target.value);
                  if (selectedOptionIssuer && e.target.value.trim() !== selectedOptionIssuer) {
                    setSelectedOptionIssuer(null);
                  }
                }}
                className="w-full rounded-lg border border-border-light bg-surface-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-gray-500 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 bg-surface-secondary dark:placeholder:text-gray-400"
                data-testid="solid-custom-url"
              />
            </div>

            {options.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-secondary">
                  {localize('com_auth_solid_select_provider' as TranslationKeys)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {options.map((opt) => {
                    const isSelected = providerUrl.trim() === opt.issuer;
                    return (
                      <button
                        key={opt.issuer}
                        type="button"
                        onClick={() => handleSelectOption(opt.issuer)}
                        className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                          isSelected
                            ? 'border-green-500 bg-surface-secondary text-text-primary'
                            : 'border-border-light bg-surface-primary text-text-primary hover:bg-surface-tertiary'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <OGDialogFooter>
            <OGDialogClose asChild>
              <Button variant="outline">{localize('com_ui_cancel' as TranslationKeys)}</Button>
            </OGDialogClose>
            <Button onClick={handleContinue} disabled={!canContinue}>
              {localize('com_auth_continue' as TranslationKeys)}
            </Button>
          </OGDialogFooter>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

export default SolidLoginButton;
