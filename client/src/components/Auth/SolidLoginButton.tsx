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

const CUSTOM_VALUE = '__custom__';

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
 * Solid login button that opens an IdP selection modal (3 default options + optional custom URL),
 * then redirects to serverDomain + '/oauth/openid?issuer=' + encodeURIComponent(selectedIssuer)
 */
function SolidLoginButton({ startupConfig, label, Icon }: SolidLoginButtonProps) {
  const [open, setOpen] = useState(false);
  const [selectedIssuer, setSelectedIssuer] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState('');

  const options = startupConfig.solidIdpOptions ?? [];
  const customEnabled = startupConfig.solidCustomEnabled === true;
  const serverDomain = startupConfig.serverDomain || '';

  const isCustomSelected = selectedIssuer === CUSTOM_VALUE;
  const effectiveIssuer = isCustomSelected ? customUrl.trim() : selectedIssuer;
  const canContinue =
    serverDomain &&
    (isCustomSelected ? isValidIssuerUrl(customUrl) : !!selectedIssuer && selectedIssuer !== CUSTOM_VALUE);

  const handleContinue = () => {
    if (!canContinue || !effectiveIssuer) return;
    const url = `${serverDomain}/oauth/openid?issuer=${encodeURIComponent(effectiveIssuer)}`;
    window.location.href = url;
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSelectedIssuer(null);
      setCustomUrl('');
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
            <OGDialogTitle>Choose Solid Identity Provider</OGDialogTitle>
            <OGDialogDescription>
              Select a provider or enter your own Solid OIDC provider URL.
            </OGDialogDescription>
          </OGDialogHeader>
          <div className="py-4 space-y-3">
            <ul className="space-y-2">
              {options.map((opt) => (
                <li key={opt.issuer}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border-light p-3 transition-colors hover:bg-surface-secondary has-[:checked]:border-green-500 has-[:checked]:bg-surface-secondary dark:has-[:checked]:border-green-500">
                    <input
                      type="radio"
                      name="solid-issuer"
                      value={opt.issuer}
                      checked={selectedIssuer === opt.issuer}
                      onChange={() => setSelectedIssuer(opt.issuer)}
                      className="h-4 w-4 border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    <span className="font-medium text-text-primary">{opt.label}</span>
                    {opt.issuer !== opt.label && (
                      <span
                        className="max-w-[180px] truncate text-xs text-gray-500 dark:text-gray-400"
                        title={opt.issuer}
                      >
                        {opt.issuer}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>

            {customEnabled && (
              <>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border-light p-3 transition-colors hover:bg-surface-secondary has-[:checked]:border-green-500 has-[:checked]:bg-surface-secondary dark:has-[:checked]:border-green-500">
                  <input
                    type="radio"
                    name="solid-issuer"
                    value={CUSTOM_VALUE}
                    checked={isCustomSelected}
                    onChange={() => setSelectedIssuer(CUSTOM_VALUE)}
                    className="mt-1 h-4 w-4 border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-text-primary block mb-1">Custom provider</span>
                    <input
                      type="url"
                      placeholder="https://your-pod.example.com/"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      onFocus={() => setSelectedIssuer(CUSTOM_VALUE)}
                      className="w-full rounded border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-gray-500 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 dark:bg-surface-secondary"
                      data-testid="solid-custom-url"
                    />
                  </div>
                </label>
              </>
            )}
          </div>
          <OGDialogFooter>
            <OGDialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </OGDialogClose>
            <Button onClick={handleContinue} disabled={!canContinue}>
              Continue
            </Button>
          </OGDialogFooter>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

export default SolidLoginButton;
