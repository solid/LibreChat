import { useState, useCallback } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle, OGDialogDescription } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface SolidProvider {
  name: string;
  url: string;
}

const DEFAULT_PROVIDERS: SolidProvider[] = [
  { name: 'Solid Community', url: 'https://solidcommunity.net/' },
  { name: 'Inrupt', url: 'https://login.inrupt.com' },
];

interface SolidProviderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderSelect: (issuer: string) => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

export default function SolidProviderModal({
  open,
  onOpenChange,
  onProviderSelect,
  isLoading = false,
  error: externalError = null,
}: SolidProviderModalProps) {
  const localize = useLocalize();
  const [customProviderUrl, setCustomProviderUrl] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<SolidProvider | null>(null);
  const [isCustomMode, setIsCustomMode] = useState(false);

  const handleProviderClick = useCallback(
    (provider: SolidProvider) => {
      setSelectedProvider(provider);
      setIsCustomMode(false);
      setCustomProviderUrl('');
    },
    [],
  );

  const handleCustomInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCustomProviderUrl(e.target.value);
    setIsCustomMode(true);
    setSelectedProvider(null);
  }, []);

  const validateIssuerUrl = useCallback((url: string): boolean => {
    if (!url.trim()) {
      return false;
    }
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
      return true; // Will be handled in handleNext
    }
  }, []);

  const handleNext = useCallback(async () => {
    let issuer: string;
    if (isCustomMode && customProviderUrl.trim()) {
      issuer = customProviderUrl.trim();
    } else if (selectedProvider) {
      issuer = selectedProvider.url;
    } else {
      return;
    }

    // Ensure URL has proper format
    if (!issuer.startsWith('http://') && !issuer.startsWith('https://')) {
      issuer = `https://${issuer}`;
    }

    // Validate URL
    if (!validateIssuerUrl(issuer)) {
      return;
    }
    
    await onProviderSelect(issuer);
  }, [isCustomMode, customProviderUrl, selectedProvider, onProviderSelect, validateIssuerUrl]);

  const isValid = isCustomMode ? customProviderUrl.trim().length > 0 : selectedProvider !== null;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-md sm:w-3/4 md:w-1/2">
        <OGDialogHeader>
          <OGDialogTitle className="text-xl font-semibold">
            {localize('com_auth_solid_provider_title')}
          </OGDialogTitle>
          <OGDialogDescription className="text-sm text-text-secondary">
            {localize('com_auth_solid_provider_description')}
          </OGDialogDescription>
        </OGDialogHeader>

        <div className="space-y-4 py-4">
          {/* Custom Provider Input */}
          <div className="space-y-2">
            <label
              htmlFor="solid-provider-url"
              className="block text-sm font-medium text-text-primary"
            >
              {localize('com_auth_solid_provider_input_label')}
            </label>
            <input
              id="solid-provider-url"
              type="text"
              value={customProviderUrl}
              onChange={handleCustomInputChange}
              placeholder={localize('com_auth_solid_provider_input_placeholder')}
              className="w-full rounded-lg border border-border-light bg-surface-primary px-4 py-2 text-text-primary placeholder:text-text-secondary focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-border-focus"
              aria-label={localize('com_auth_solid_provider_input_label')}
            />
          </div>

          {/* Provider List */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">
              {localize('com_auth_solid_provider_list_label')}
            </p>
            <div className="space-y-2 rounded-lg border border-border-light bg-surface-secondary p-2">
              {DEFAULT_PROVIDERS.map((provider) => (
                <button
                  key={provider.url}
                  type="button"
                  onClick={() => handleProviderClick(provider)}
                  className={`w-full rounded-md px-4 py-3 text-left transition-colors ${
                    selectedProvider?.url === provider.url && !isCustomMode
                      ? 'bg-surface-active border-2 border-border-focus'
                      : 'border border-transparent hover:bg-surface-hover'
                  }`}
                  aria-pressed={selectedProvider?.url === provider.url && !isCustomMode}
                  aria-label={`${localize('com_auth_solid_provider_select')} ${provider.name}`}
                >
                  <div className="font-semibold text-text-primary">{provider.name}</div>
                  <div className="text-sm text-text-secondary">{provider.url}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-border-light bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-border-focus"
            aria-label={localize('com_ui_cancel')}
          >
            {localize('com_ui_cancel')}
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!isValid || isLoading}
            className="rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={isLoading ? localize('com_ui_loading') : localize('com_ui_next')}
          >
            {isLoading ? localize('com_ui_loading') || 'Loading...' : localize('com_ui_next')}
          </button>
          {externalError && (
            <p className="mt-2 text-sm text-red-500" role="alert">
              {externalError}
            </p>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

