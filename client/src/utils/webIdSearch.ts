/**
 * WebID Search API Service
 * 
 * Integrates with the WebID search API to find Solid users by name or WebID.
 */

export interface WebIdSearchResult {
  webid: string;
  name: string;
  img: string | null;
}

export interface WebIdSearchResponse {
  query: string;
  count: number;
  results: WebIdSearchResult[];
}

const SEARCH_API_URL = 'http://webid-search.solidproject.org/api/search';

/**
 * Searches for WebIDs using the WebID search API
 */
export async function searchWebIds(query: string): Promise<WebIdSearchResult[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  try {
    const response = await fetch(`${SEARCH_API_URL}?q=${encodeURIComponent(query.trim())}`);
    
    if (!response.ok) {
      throw new Error(`WebID search failed: ${response.statusText}`);
    }

    const data: WebIdSearchResponse = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Error searching WebIDs:', error);
    throw error;
  }
}

