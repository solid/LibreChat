import React from 'react';

interface SocialButtonProps {
  id: string;
  enabled: boolean;
  serverDomain?: string;
  oauthPath?: string;
  Icon: React.ComponentType;
  label: string;
  onClick?: () => void;
}

const SocialButton = ({ id, enabled, serverDomain, oauthPath, Icon, label, onClick }: SocialButtonProps) => {
  if (!enabled) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.preventDefault();
      onClick();
    }
  };

  const buttonContent = (
    <>
      <Icon />
      <p>{label}</p>
    </>
  );

  if (onClick) {
    return (
      <div className="mt-2 flex gap-x-2">
        <button
          type="button"
          aria-label={label}
          className="flex w-full items-center space-x-3 rounded-2xl border border-border-light bg-surface-primary px-5 py-3 text-text-primary transition-colors duration-200 hover:bg-surface-tertiary"
          onClick={handleClick}
          data-testid={id}
        >
          {buttonContent}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex gap-x-2">
      <a
        aria-label={label}
        className="flex w-full items-center space-x-3 rounded-2xl border border-border-light bg-surface-primary px-5 py-3 text-text-primary transition-colors duration-200 hover:bg-surface-tertiary"
        href={`${serverDomain}/oauth/${oauthPath}`}
        data-testid={id}
      >
        {buttonContent}
      </a>
    </div>
  );
};

export default SocialButton;
