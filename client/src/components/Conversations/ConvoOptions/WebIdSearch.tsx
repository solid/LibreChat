import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Search, User, Loader2, Check } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { useSolidAuth } from '@ldo/solid-react';
import { searchWebIds, type WebIdSearchResult } from '~/utils/webIdSearch';
import { fetchWebIdProfile, type WebIdProfile } from '~/utils/webIdProfile';
import { cn } from '~/utils';

interface WebIdSearchProps {
  onSelect: (webId: string) => void;
  selectedWebId: string | null;
}

/**
 * Validates if a string looks like a WebID URL
 */
function isValidWebIdUrl(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) && trimmed.length > 10; // Basic length check
}

export default function WebIdSearch({ onSelect, selectedWebId }: WebIdSearchProps) {
  const { session } = useSolidAuth();
  // session might be null if user is not logged in with Solid, which is fine for public profile cards
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WebIdSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<boolean>(false);
  const [showResults, setShowResults] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [webIdProfile, setWebIdProfile] = useState<WebIdProfile | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [imageError, setImageError] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close results when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setResults([]);
      setShowResults(false);
      setShowManualEntry(false);
      setSearchError(false);
      return;
    }

    // If the query looks like a WebID URL, show manual entry option immediately
    if (isValidWebIdUrl(searchQuery)) {
      setResults([]);
      setShowResults(false);
      setShowManualEntry(true);
      setSearchError(false);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setError(null);
    setSearchError(false);

    try {
      const searchResults = await searchWebIds(searchQuery);
      setResults(searchResults);
      
      // If no results but query looks like a WebID, show manual entry option
      if (searchResults.length === 0 && isValidWebIdUrl(searchQuery)) {
        setShowResults(false);
        setShowManualEntry(true);
      } else if (searchResults.length === 0) {
        setShowResults(false);
        setShowManualEntry(false);
      } else {
        setShowResults(true);
        setShowManualEntry(false);
      }
    } catch (err) {
      // On error, if query looks like a WebID, allow manual entry
      setSearchError(true);
      setResults([]);
      setShowResults(false);
      
      if (isValidWebIdUrl(searchQuery)) {
        setShowManualEntry(true);
      } else {
        setShowManualEntry(false);
        setError(err instanceof Error ? err.message : 'Failed to search WebIDs');
      }
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newQuery = e.target.value;
      setQuery(newQuery);
      setError(null);
      setSearchError(false);

      // Clear previous timeout
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // If it looks like a WebID URL, show manual entry immediately
      if (isValidWebIdUrl(newQuery)) {
        setShowManualEntry(true);
        setShowResults(false);
        setResults([]);
        return;
      }

      // Debounce search
      if (newQuery.trim().length >= 2) {
        searchTimeoutRef.current = setTimeout(() => {
          performSearch(newQuery);
        }, 300);
      } else {
        setResults([]);
        setShowResults(false);
        setShowManualEntry(false);
      }
    },
    [performSearch],
  );


  // Fetch WebID profile when a WebID is selected
  useEffect(() => {
    if (selectedWebId && selectedWebId.trim().length > 0 && isValidWebIdUrl(selectedWebId)) {
      setIsLoadingProfile(true);
      setImageError(false);

      fetchWebIdProfile(selectedWebId, null)
        .then((profile) => {
          setWebIdProfile(profile);
        })
        .catch((err) => {
          console.error('Failed to fetch WebID profile:', err);
          setWebIdProfile({
            webId: selectedWebId,
            name: null,
            image: null,
          });
        })
        .finally(() => {
          setIsLoadingProfile(false);
        });
    } else {
      setWebIdProfile(null);
      setImageError(false);
    }
  }, [selectedWebId, session]);

  const handleSelect = useCallback(
    (webId: string) => {
      onSelect(webId);
      // Keep the query so the selected WebID is visible
      setQuery(webId);
      setResults([]);
      setShowResults(false);
      setShowManualEntry(false);
      setError(null);
      setSearchError(false);
    },
    [onSelect],
  );

  const handleManualSelect = useCallback(() => {
    if (isValidWebIdUrl(query)) {
      handleSelect(query.trim());
    }
  }, [query, handleSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Allow Enter key to select if manual entry is available
      if (e.key === 'Enter' && showManualEntry && isValidWebIdUrl(query)) {
        e.preventDefault();
        handleSelect(query.trim());
      }
    },
    [query, showManualEntry, handleSelect],
  );

  const selectedResult = results.find((r) => r.webid === selectedWebId);
  const hasSelectedWebId = !!(selectedWebId && selectedWebId.trim().length > 0);

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
        <input
          type="text"
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          placeholder="Search for WebID or name, or paste a WebID URL..."
          className={cn(
            'w-full rounded-lg border border-border-light bg-surface-primary px-10 py-2 text-sm',
            'focus:border-border-medium focus:outline-none focus:ring-2 focus:ring-border-medium',
            'placeholder:text-text-tertiary',
            hasSelectedWebId && 'bg-surface-secondary',
          )}
          disabled={hasSelectedWebId && !showManualEntry}
        />
        {isSearching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Loader2 className="size-4 animate-spin text-text-secondary" />
          </div>
        )}
      </div>

      {/* Error message for search failures */}
      {error && !showManualEntry && (
        <div className="mt-2 text-sm text-red-500">{error}</div>
      )}

      {/* Manual entry option when search fails or returns no results but query looks like WebID */}
      {showManualEntry && isValidWebIdUrl(query) && (
        <div className="mt-2 rounded-lg border border-border-light bg-surface-secondary p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex-1">
              <div className="text-sm font-medium text-text-primary">
                {searchError
                  ? 'Search unavailable - Use WebID directly'
                  : results.length === 0
                    ? 'No results found - Use WebID directly'
                    : 'Use this WebID'}
              </div>
              <div className="mt-1 break-all text-xs text-text-secondary">{query.trim()}</div>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleManualSelect}
            className="w-full"
          >
            <Check className="mr-2 size-4" />
            Use this WebID
          </Button>
          <div className="mt-2 text-xs text-text-tertiary">
            Press Enter or click the button to use this WebID
          </div>
        </div>
      )}

      {/* Show message when search fails and query doesn't look like WebID */}
      {searchError && !showManualEntry && query.trim().length >= 2 && (
        <div className="mt-2 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
          <div className="text-sm text-yellow-600 dark:text-yellow-400">
            Search unavailable. You can paste a full WebID URL (starting with http:// or https://) to use it directly.
          </div>
        </div>
      )}

      {showResults && results.length > 0 && (
        <div className="absolute z-50 mt-2 max-h-64 w-full overflow-y-auto rounded-lg border border-border-light bg-surface-primary shadow-lg">
          {results.map((result) => (
            <button
              key={result.webid}
              type="button"
              onClick={() => handleSelect(result.webid)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover',
                selectedWebId === result.webid && 'bg-surface-hover',
              )}
            >
              {result.img ? (
                <img
                  src={result.img}
                  alt={result.name}
                  className="size-8 rounded-full object-cover"
                />
              ) : (
                <div className="flex size-8 items-center justify-center rounded-full bg-surface-secondary">
                  <User className="size-4 text-text-secondary" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium text-text-primary">{result.name}</div>
                <div className="truncate text-xs text-text-secondary">{result.webid}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Show selected WebID - either from search results or manually entered */}
      {hasSelectedWebId && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border-light bg-surface-secondary px-3 py-2">
          {isLoadingProfile ? (
            <div className="flex size-6 items-center justify-center rounded-full bg-surface-primary">
              <Loader2 className="size-3 animate-spin text-text-secondary" />
            </div>
          ) : selectedResult?.img ? (
            <img
              src={selectedResult.img}
              alt={selectedResult.name || 'WebID'}
              className="size-6 rounded-full object-cover"
            />
          ) : webIdProfile?.image && !imageError ? (
            <img
              src={webIdProfile.image}
              alt={webIdProfile.name || 'WebID'}
              className="size-6 rounded-full object-cover"
              onError={() => {
                setImageError(true);
              }}
            />
          ) : (
            <div className="flex size-6 items-center justify-center rounded-full bg-surface-primary">
              <User className="size-3 text-text-secondary" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            {selectedResult ? (
              <>
                <div className="truncate text-sm font-medium text-text-primary">{selectedResult.name}</div>
                <div className="truncate text-xs text-text-secondary">{selectedResult.webid}</div>
              </>
            ) : webIdProfile?.name ? (
              <>
                <div className="truncate text-sm font-medium text-text-primary">{webIdProfile.name}</div>
                <div className="truncate text-xs text-text-secondary">{webIdProfile.webId}</div>
              </>
            ) : (
              <>
                <div className="truncate text-sm font-medium text-text-primary">
                  {isLoadingProfile ? 'Loading profile...' : 'Selected WebID'}
                </div>
                <div className="truncate text-xs text-text-secondary">{selectedWebId}</div>
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSelect('');
              setQuery('');
              setShowManualEntry(false);
              setWebIdProfile(null);
            }}
            className="h-6 w-6 p-0"
            aria-label="Clear selection"
          >
            ×
          </Button>
        </div>
      )}
    </div>
  );
}

