import React, { useState, useCallback, useEffect } from 'react';
import { Copy, CopyCheck } from 'lucide-react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import { useSolidAuth } from '@ldo/solid-react';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import { grantPublicReadAccess } from '~/utils/solidAcp';
import { dataService } from 'librechat-data-provider';
import { cn } from '~/utils';
import { NotificationSeverity } from '~/common';
import { useGetConvoIdQuery } from '~/data-provider';

interface SolidShareDialogProps {
  conversationId: string;
  podUrl: string; // Full URL to the conversation file on the Pod
  onClose: () => void;
}

export default function SolidShareDialog({
  conversationId,
  podUrl,
  onClose,
}: SolidShareDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { session, fetch: solidFetch } = useSolidAuth();
  
  // Check if user is logged in with Solid and has authenticated fetch
  const isSolidLoggedIn = session?.isLoggedIn && !!session?.webId && !!solidFetch;
  
  const [sharedLink, setSharedLink] = useState('');
  const [isCopying, setIsCopying] = useState(false);
  const [isCreatingLink, setIsCreatingLink] = useState(false);
  const copyLink = useCopyToClipboard({ text: sharedLink });
  
  // Get conversation title
  const { data: conversation } = useGetConvoIdQuery(conversationId, {
    enabled: !!conversationId,
  });

  // Check for existing share on mount and ensure public access is granted
  useEffect(() => {
    const checkExistingShare = async () => {
      if (!podUrl) {
        return;
      }

      try {
        const result = await dataService.getSolidSharedLink(podUrl);
        if (result?.success && result?.shareId) {
          const baseUrl = `${window.location.protocol}//${window.location.host}`;
          const link = `${baseUrl}/share/${result.shareId}`;
          setSharedLink(link);

          // Ensure public access is granted (in case it wasn't granted before)
          if (isSolidLoggedIn && solidFetch) {
            try {
              const sessionWithFetch = { ...session, fetch: solidFetch };
              await grantPublicReadAccess(podUrl, sessionWithFetch);
            } catch (accessError) {
              console.debug('Failed to grant public access (may already be granted):', accessError);
              // Silently fail - access might already be granted
            }
          }
        }
      } catch (error) {
        // Silently fail - share doesn't exist yet
        console.debug('No existing share found for podUrl:', podUrl);
      }
    };

    checkExistingShare();
  }, [podUrl, isSolidLoggedIn, solidFetch, session]);

  // Create share link when user clicks "Create link"
  const handleCreateLink = useCallback(async () => {
    if (!podUrl) {
      return;
    }

    setIsCreatingLink(true);
    try {
      // @ts-expect-error - createSolidSharedLink exists but types may not be updated
      const result = await dataService.createSolidSharedLink(podUrl, conversation?.title);
      if (result?.shareId) {
        // Grant public read access to the Pod resource so it can be accessed without authentication
        if (isSolidLoggedIn && solidFetch) {
          try {
            const sessionWithFetch = { ...session, fetch: solidFetch };
            await grantPublicReadAccess(podUrl, sessionWithFetch);
          } catch (accessError) {
            console.error('Failed to grant public access:', accessError);
           
            showToast({
              message: 'Share link created, but failed to grant public access. The link may not be accessible.',
              severity: NotificationSeverity.WARNING,
              showIcon: true,
            });
          }
        }

        const baseUrl = `${window.location.protocol}//${window.location.host}`;
        const link = `${baseUrl}/share/${result.shareId}`;
        setSharedLink(link);
        showToast({
          message: 'Share link created successfully',
          severity: NotificationSeverity.SUCCESS,
          showIcon: true,
        });
      }
    } catch (error: any) {
      console.error('Failed to create share link:', error);
      const errorMessage = error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Unknown error';
      console.error('Error details:', {
        message: errorMessage,
        status: error?.response?.status,
        data: error?.response?.data,
      });
      
      // If share already exists, fetch it instead
      if (errorMessage.includes('Share already exists') || errorMessage.includes('SHARE_EXISTS')) {
        try {
          const result = await dataService.getSolidSharedLink(podUrl);
          if (result?.success && result?.shareId) {
            const baseUrl = `${window.location.protocol}//${window.location.host}`;
            const link = `${baseUrl}/share/${result.shareId}`;
            setSharedLink(link);
            showToast({
              message: 'Using existing share link',
              severity: NotificationSeverity.SUCCESS,
              showIcon: true,
            });
            return;
          }
        } catch (fetchError) {
          console.error('Failed to fetch existing share:', fetchError);
        }
      }
      
      showToast({
        message: `Failed to create share link: ${errorMessage}`,
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    } finally {
      setIsCreatingLink(false);
    }
  }, [podUrl, conversation?.title, showToast, isSolidLoggedIn, solidFetch, session]);

  const handleCopyLink = useCallback(() => {
    if (isCopying) {
      return;
    }
    copyLink(setIsCopying);
    showToast({
      message: localize('com_ui_copy_link_success') || 'Link copied to clipboard',
      severity: NotificationSeverity.SUCCESS,
      showIcon: true,
    });
  }, [copyLink, isCopying, showToast, localize]);

  return (
    <div className="flex flex-col gap-4">
      {/* Privacy message */}
      <div className="rounded-lg bg-surface-secondary p-3 text-sm text-text-primary">
        {localize('com_ui_share_privacy_message') ||
          'Your name and any messages you add after sharing stay private.'}
      </div>

      {/* Shareable link */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-text-primary">
          {localize('com_ui_share_link') || 'Shareable Link'}
        </label>
        {!sharedLink ? (
          <Button
            variant="submit"
            onClick={handleCreateLink}
            disabled={isCreatingLink}
            className="w-full"
          >
            {isCreatingLink ? (
              <>
                <Spinner className="mr-2 size-4" />
                Creating link...
              </>
            ) : (
              'Create link'
            )}
          </Button>
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-surface-secondary p-2">
            <div className="flex-1 break-all text-sm text-text-secondary">{sharedLink}</div>
            <Button
              size="sm"
              variant="outline"
              aria-label={localize('com_ui_copy_link') || 'Copy link'}
              onClick={handleCopyLink}
              className={cn('shrink-0', isCopying ? 'cursor-default' : '')}
            >
              {isCopying ? <CopyCheck className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        )}
      </div>

    </div>
  );
}

