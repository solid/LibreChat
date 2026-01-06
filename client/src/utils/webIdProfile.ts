/**
 * WebID Profile Utilities
 * 
 * Functions for fetching and parsing WebID profile cards to extract name and image.
 * Uses LDO to parse RDF data from Solid Pod profile cards.
 */

import { parseRdf } from '@ldo/ldo';

// Type for session-like object with optional fetch, or any object (for compatibility)
// Profile cards are typically public, so we don't need authenticated fetch
type SessionLike = {
  fetch?: typeof fetch;
} | null | undefined | unknown;

export interface WebIdProfile {
  webId: string;
  name: string | null;
  image: string | null;
}

const FOAF_NS = 'http://xmlns.com/foaf/0.1/';

/**
 * Extracts the profile card URL from a WebID
 * WebIDs typically have a fragment (#me) and the profile card is at the base URL
 */
function getProfileCardUrl(webId: string): string {
  // Remove fragment if present
  const url = new URL(webId);
  url.hash = '';
  return url.toString();
}

/**
 * Fetches and parses a WebID profile card to extract name and image
 */
export async function fetchWebIdProfile(
  webId: string,
  session: SessionLike,
): Promise<WebIdProfile | null> {
  try {
    const profileCardUrl = getProfileCardUrl(webId);
    
    // Use session.fetch if available (for authenticated requests), otherwise use regular fetch
    // Profile cards are typically publicly accessible, so regular fetch should work
    const fetchFn = (session && typeof session === 'object' && 'fetch' in session && typeof session.fetch === 'function')
      ? session.fetch
      : fetch;

    // Fetch the profile card
    console.log('Fetching profile card from:', profileCardUrl);
    const response = await fetchFn(profileCardUrl, {
      headers: {
        Accept: 'text/turtle, application/ld+json, text/n3',
      },
    });

    if (!response.ok) {
      console.warn('Profile card not accessible:', response.status, response.statusText);
      // If profile card is not accessible, return basic info
      return {
        webId,
        name: null,
        image: null,
      };
    }

    const contentType = response.headers.get('Content-Type') || '';
    let rdfText: string;

    // Handle different RDF formats
    if (contentType.includes('application/ld+json')) {
      // For JSON-LD, we'd need to convert to Turtle or parse differently
      // For now, try to parse as text and extract manually
      rdfText = await response.text();
    } else {
      // Turtle or N3 format
      rdfText = await response.text();
    }

    // Parse RDF using LDO
    const dataset = await parseRdf(rdfText, {
      baseIRI: profileCardUrl,
      format: contentType.includes('application/ld+json') ? 'application/ld+json' : 'Turtle',
    });

    // Extract the subject (usually the WebID with #me fragment or the profile card URL)
    // Try multiple possible subject URIs
    const possibleSubjects = [
      webId,
      webId.includes('#') ? webId : `${profileCardUrl}#me`,
      `${profileCardUrl}#me`,
      profileCardUrl,
    ];

    let name: string | null = null;
    let image: string | null = null;

    // Parse the RDF text directly - more reliable than dataset queries
    // First, try to use the dataset if available
    try {
      // Try to iterate the dataset to find FOAF properties
      if (dataset && typeof dataset.match === 'function') {
        // Get all quads
        const allQuads = dataset.match(null, null, null);
        if (allQuads) {
          for (const quad of allQuads) {
            const subjectValue = quad.subject?.value || '';
            const predicate = quad.predicate?.value || '';
            const objectValue = quad.object?.value || '';

            // Check if this quad's subject matches any of our possible subjects
            const matchesSubject = possibleSubjects.some((subj) => 
              subjectValue === subj || subjectValue.includes(subj.split('#')[0])
            );

            if (matchesSubject) {
              if (predicate === `${FOAF_NS}name` && !name) {
                name = objectValue.replace(/^"(.*)"$/, '$1');
              }
              if (
                (predicate === `${FOAF_NS}img` || predicate === `${FOAF_NS}depiction`) &&
                !image
              ) {
                image = objectValue.replace(/^"(.*)"$/, '$1');
              }
            }
          }
        }
      }
    } catch (e) {
      console.debug('Failed to query dataset:', e);
    }

    // Primary parsing: Parse Turtle/N3 text directly (more reliable)
    if ((!name || !image) && !contentType.includes('application/ld+json')) {
      // Parse line by line, handling multi-line statements
      const lines = rdfText.split('\n');
      let currentSubject = '';
      let inMultiLine = false;
      let currentStatement = '';

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        // Skip comments and empty lines
        if (!line || line.startsWith('#')) {
          continue;
        }

        // Handle multi-line statements (lines ending with ; or ,)
        if (line.endsWith(';') || line.endsWith(',')) {
          inMultiLine = true;
          currentStatement += line.slice(0, -1) + ' ';
          continue;
        }

        if (inMultiLine) {
          currentStatement += line;
          if (line.endsWith('.')) {
            line = currentStatement.slice(0, -1); // Remove the final .
            inMultiLine = false;
            currentStatement = '';
          } else {
            continue;
          }
        }

        // Extract subject from line (look for <...> or #me)
        const subjectMatch = line.match(/^<([^>]+)>/);
        if (subjectMatch) {
          currentSubject = subjectMatch[1];
        } else if (line.includes('#me')) {
          // Handle relative subject like #me
          currentSubject = profileCardUrl + '#me';
        }

        // Check if this line is about one of our subjects
        const isAboutSubject = possibleSubjects.some(subj => 
          line.includes(subj) || 
          line.includes(subj.split('#')[0]) ||
          (currentSubject && possibleSubjects.some(ps => ps.includes(currentSubject) || currentSubject.includes(ps.split('#')[0])))
        );

        if (isAboutSubject || currentSubject) {
          // Look for foaf:name
          const namePatterns = [
            /foaf:name\s+"([^"]+)"/,
            /foaf:name\s+<([^>]+)>/,
            /<http:\/\/xmlns\.com\/foaf\/0\.1\/name>\s+"([^"]+)"/,
            /<http:\/\/xmlns\.com\/foaf\/0\.1\/name>\s+<([^>]+)>/,
          ];
          
          for (const pattern of namePatterns) {
            const match = line.match(pattern);
            if (match && !name) {
              name = match[1];
              break;
            }
          }

          // Look for foaf:img or foaf:depiction
          const imgPatterns = [
            /foaf:(?:img|depiction)\s+<([^>]+)>/,
            /foaf:(?:img|depiction)\s+"([^"]+)"/,
            /<http:\/\/xmlns\.com\/foaf\/0\.1\/(?:img|depiction)>\s+<([^>]+)>/,
            /<http:\/\/xmlns\.com\/foaf\/0\.1\/(?:img|depiction)>\s+"([^"]+)"/,
          ];

          for (const pattern of imgPatterns) {
            const match = line.match(pattern);
            if (match && !image) {
              image = match[1];
              break;
            }
          }
        }
      }
    }

    // Handle JSON-LD format
    if ((!name || !image) && contentType.includes('application/ld+json')) {
      try {
        const jsonData = JSON.parse(rdfText);
        const graph = Array.isArray(jsonData) ? jsonData : jsonData['@graph'] || [jsonData];
        
        for (const item of graph) {
          const id = item['@id'] || item.id;
          if (!id) continue;

          // Check if this item matches our WebID
          const matchesSubject = possibleSubjects.some(subj => 
            id === subj || id.includes(subj.split('#')[0])
          );

          if (matchesSubject) {
            // Extract name
            if (!name) {
              const nameValue = item[`${FOAF_NS}name`] || item.name || item['foaf:name'] || null;
              if (nameValue) {
                if (Array.isArray(nameValue) && nameValue.length > 0) {
                  name = nameValue[0];
                } else if (typeof nameValue === 'object' && nameValue && '@value' in nameValue) {
                  name = (nameValue as { '@value': string })['@value'];
                } else if (typeof nameValue === 'string') {
                  name = nameValue;
                }
              }
            }

            // Extract image
            if (!image) {
              const imageValue = item[`${FOAF_NS}img`] || item[`${FOAF_NS}depiction`] || item.img || item.depiction || item['foaf:img'] || item['foaf:depiction'] || null;
              if (imageValue) {
                if (Array.isArray(imageValue) && imageValue.length > 0) {
                  image = imageValue[0];
                } else if (typeof imageValue === 'object' && imageValue && '@id' in imageValue) {
                  image = (imageValue as { '@id': string })['@id'];
                } else if (typeof imageValue === 'object' && imageValue && '@value' in imageValue) {
                  image = (imageValue as { '@value': string })['@value'];
                } else if (typeof imageValue === 'string') {
                  image = imageValue;
                }
              }
            }
          }
        }
      } catch (e) {
        console.debug('Failed to parse JSON-LD:', e);
      }
    }

    const result = {
      webId,
      name: name || null,
      image: image || null,
    };
    
    return result;
  } catch (error) {
    console.error('Error fetching WebID profile:', error);
    // Return basic info on error
    return {
      webId,
      name: null,
      image: null,
    };
  }
}

