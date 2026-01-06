/**
 * Solid ACP (Access Control Policy) Utilities
 * 
 * Functions for granting read access to Solid Pod resources using ACP.
 * This implementation is simplified for read-only access.
 */

import { DataFactory, Writer } from 'n3';

// Type for session with authenticated fetch (required for ACP operations)
type SessionWithFetch = {
  fetch: typeof fetch;
};

const ACP = {
  Read: 'http://www.w3.org/ns/solid/acp#Read',
} as const;

const ACP_NS = 'http://www.w3.org/ns/solid/acp#';
const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const FOAF_NS = 'http://xmlns.com/foaf/0.1/';

/**
 * Gets the ACL or ACR URL for a resource and detects which system is being used
 */
async function getAccessControlUrl(
  resourceUrl: string,
  fetchFn: typeof fetch,
): Promise<{ url: string; type: 'acl' | 'acp' }> {
  try {
    const response = await fetchFn(resourceUrl, {
      method: 'HEAD',
      headers: {
        Accept: '*/*',
      },
    });

    const linkHeader = response.headers.get('Link');
    if (linkHeader) {
      const aclMatch = linkHeader.match(/<([^>]+)>;\s*rel=["']acl["']/i);
      if (aclMatch && aclMatch[1]) {
        const aclUrl = aclMatch[1];
        // Check if it's ACP (.acr) or ACL (.acl)
        if (aclUrl.includes('.acr')) {
          return { url: aclUrl, type: 'acp' };
        }
        if (aclUrl.includes('.acl')) {
          return { url: aclUrl, type: 'acl' };
        }
        // Default to ACL if we can't determine
        return { url: aclUrl, type: 'acl' };
      }
    }
  } catch (error) {
    console.warn('Failed to discover access control URL via Link header:', error);
  }

  // Default: try ACL first (more common), then ACP
  if (resourceUrl.endsWith('/')) {
    return { url: resourceUrl + '.acl', type: 'acl' };
  }
  return { url: resourceUrl + '.acl', type: 'acl' };
}

/**
 * Gets the ACR (Access Control Resource) URL for a resource (legacy function for ACP)
 */
async function getAcrUrl(resourceUrl: string, fetchFn: typeof fetch): Promise<string> {
  const { url } = await getAccessControlUrl(resourceUrl, fetchFn);
  return url;
}

/**
 * Fetches an existing ACR or returns null if it doesn't exist
 */
async function fetchAcr(
  acrUrl: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchFn(acrUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/turtle',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch ACR: ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    if ((error as any)?.status === 404 || (error as any)?.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Checks if public access already exists in ACR Turtle content
 */
function hasPublicAccess(acrTurtle: string): boolean {
  // Check for acp:agentClass with foaf:Agent (public access)
  return acrTurtle.includes('acp:agentClass') && acrTurtle.includes('foaf:Agent');
}

/**
 * Checks if public access already exists in ACL Turtle content
 */
function hasPublicAccessAcl(aclTurtle: string): boolean {
  // Check for acl:agentClass with foaf:Agent (public access)
  return aclTurtle.includes('acl:agentClass') && aclTurtle.includes('foaf:Agent');
}

/**
 * Extracts existing agents from ACR Turtle content
 */
function extractExistingAgents(acrTurtle: string): Set<string> {
  const existingAgents = new Set<string>();
  
  // Simple regex-based extraction (for read-only access, we only need to check Read permissions)
  const agentMatches = acrTurtle.matchAll(/<([^>]+)>[\s\S]*?acp:agent[\s\S]*?<([^>]+)>/g);
  
  for (const match of agentMatches) {
    if (match[2] && match[2].startsWith('http')) {
      existingAgents.add(match[2]);
    }
  }
  
  // More robust: parse for acp:agent patterns
  const lines = acrTurtle.split('\n');
  let inMatcher = false;
  let currentAgent: string | null = null;
  
  for (const line of lines) {
    if (line.includes('acp:Matcher') || line.includes('a acp:Matcher')) {
      inMatcher = true;
      currentAgent = null;
    }
    if (inMatcher && line.includes('acp:agent')) {
      const agentMatch = line.match(/<([^>]+)>/);
      if (agentMatch && agentMatch[1]) {
        currentAgent = agentMatch[1];
        if (currentAgent.startsWith('http')) {
          existingAgents.add(currentAgent);
        }
      }
    }
    if (inMatcher && line.trim().endsWith('.')) {
      inMatcher = false;
    }
  }
  
  return existingAgents;
}

/**
 * Creates a new ACR with read access for the given WebIDs
 */
async function createAcr(
  resourceUrl: string,
  acrUrl: string,
  webIds: string[],
): Promise<string> {
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  const acrSubject = namedNode(acrUrl);

  // Add ACR type and resource
  quads.push(quad(acrSubject, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControlResource`)));
  quads.push(quad(acrSubject, namedNode(`${ACP_NS}resource`), namedNode(resourceUrl)));

  // Create Access Controls for each WebID
  let controlIndex = 0;

  webIds.forEach((webId) => {
    // Create blank nodes for nested structure
    const matcherNode = blankNode(`matcher_${controlIndex}`);
    const policyNode = blankNode(`policy_${controlIndex}`);
    const accessControlNode = blankNode(`accessControl_${controlIndex}`);

    // Matcher: type and agent
    quads.push(quad(matcherNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Matcher`)));
    quads.push(quad(matcherNode, namedNode(`${ACP_NS}agent`), namedNode(webId)));

    // Policy: type, allow (Read), and anyOf (matcher)
    quads.push(quad(policyNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Policy`)));
    quads.push(quad(policyNode, namedNode(`${ACP_NS}allow`), namedNode(ACP.Read)));
    quads.push(quad(policyNode, namedNode(`${ACP_NS}anyOf`), matcherNode));

    // AccessControl: type and apply (policy)
    quads.push(quad(accessControlNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControl`)));
    quads.push(quad(accessControlNode, namedNode(`${ACP_NS}apply`), policyNode));

    // Link AccessControl to ACR
    quads.push(quad(acrSubject, namedNode(`${ACP_NS}accessControl`), accessControlNode));

    controlIndex++;
  });

  // Convert quads to Turtle using N3 Writer
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acp: ACP_NS, rdf: RDF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Updates an existing ACR by adding new read access for the given WebIDs
 */
async function updateAcr(
  existingTurtle: string,
  acrUrl: string,
  webIds: string[],
): Promise<string> {
  // Extract existing agents
  const existingAgents = extractExistingAgents(existingTurtle);

  // Filter out WebIDs that already have access
  const newWebIds = webIds.filter((webId) => !existingAgents.has(webId));
  
  if (newWebIds.length === 0) {
    // No new WebIDs to add, return existing Turtle
    return existingTurtle;
  }

  // Build new access controls using N3.js
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  const acrSubject = namedNode(acrUrl);
  let controlIndex = existingAgents.size;

  // Create new access controls for new WebIDs
  newWebIds.forEach((webId) => {
    const matcherNode = blankNode(`matcher_${controlIndex}`);
    const policyNode = blankNode(`policy_${controlIndex}`);
    const accessControlNode = blankNode(`accessControl_${controlIndex}`);

    quads.push(quad(matcherNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Matcher`)));
    quads.push(quad(matcherNode, namedNode(`${ACP_NS}agent`), namedNode(webId)));

    quads.push(quad(policyNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Policy`)));
    quads.push(quad(policyNode, namedNode(`${ACP_NS}allow`), namedNode(ACP.Read)));
    quads.push(quad(policyNode, namedNode(`${ACP_NS}anyOf`), matcherNode));

    quads.push(quad(accessControlNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControl`)));
    quads.push(quad(accessControlNode, namedNode(`${ACP_NS}apply`), policyNode));

    quads.push(quad(acrSubject, namedNode(`${ACP_NS}accessControl`), accessControlNode));

    controlIndex++;
  });

  // Convert new quads to Turtle
  const newTurtle = await new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acp: ACP_NS, rdf: RDF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  // Combine existing and new Turtle
  return existingTurtle + '\n' + newTurtle;
}

/**
 * Creates a new ACR with public read access
 */
async function createPublicAcr(
  resourceUrl: string,
  acrUrl: string,
): Promise<string> {
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  const acrSubject = namedNode(acrUrl);

  // Add ACR type and resource
  quads.push(quad(acrSubject, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControlResource`)));
  quads.push(quad(acrSubject, namedNode(`${ACP_NS}resource`), namedNode(resourceUrl)));

  // Create Access Control for public access
  const matcherNode = blankNode('matcher_public');
  const policyNode = blankNode('policy_public');
  const accessControlNode = blankNode('accessControl_public');

  // Matcher: type and agentClass (foaf:Agent = anyone)
  quads.push(quad(matcherNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Matcher`)));
  quads.push(quad(matcherNode, namedNode(`${ACP_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));

  // Policy: type, allow (Read), and anyOf (matcher)
  quads.push(quad(policyNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Policy`)));
  quads.push(quad(policyNode, namedNode(`${ACP_NS}allow`), namedNode(ACP.Read)));
  quads.push(quad(policyNode, namedNode(`${ACP_NS}anyOf`), matcherNode));

  // AccessControl: type and apply (policy)
  quads.push(quad(accessControlNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControl`)));
  quads.push(quad(accessControlNode, namedNode(`${ACP_NS}apply`), policyNode));

  // Link AccessControl to ACR
  quads.push(quad(acrSubject, namedNode(`${ACP_NS}accessControl`), accessControlNode));

  // Convert quads to Turtle using N3 Writer
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acp: ACP_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Updates an existing ACR by adding public read access
 */
async function updateAcrWithPublicAccess(
  existingTurtle: string,
  acrUrl: string,
): Promise<string> {
  // Check if public access already exists
  if (hasPublicAccess(existingTurtle)) {
    return existingTurtle; // Public access already exists
  }

  // Build new access control for public access
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  const acrSubject = namedNode(acrUrl);

  // Create Access Control for public access
  const matcherNode = blankNode('matcher_public');
  const policyNode = blankNode('policy_public');
  const accessControlNode = blankNode('accessControl_public');

  quads.push(quad(matcherNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Matcher`)));
  quads.push(quad(matcherNode, namedNode(`${ACP_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));

  quads.push(quad(policyNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}Policy`)));
  quads.push(quad(policyNode, namedNode(`${ACP_NS}allow`), namedNode(ACP.Read)));
  quads.push(quad(policyNode, namedNode(`${ACP_NS}anyOf`), matcherNode));

  quads.push(quad(accessControlNode, namedNode(`${RDF_NS}type`), namedNode(`${ACP_NS}AccessControl`)));
  quads.push(quad(accessControlNode, namedNode(`${ACP_NS}apply`), policyNode));

  quads.push(quad(acrSubject, namedNode(`${ACP_NS}accessControl`), accessControlNode));

  // Convert new quads to Turtle
  const newTurtle = await new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acp: ACP_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  // Combine existing and new Turtle
  return existingTurtle + '\n' + newTurtle;
}

/**
 * Creates a new ACL with public read access
 */
async function createPublicAcl(
  resourceUrl: string,
  aclUrl: string,
): Promise<string> {
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  // Create Authorization for public access
  const authNode = blankNode('publicAuth');

  // Authorization: type
  quads.push(quad(authNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
  
  // Authorization: agentClass (foaf:Agent = anyone/public)
  quads.push(quad(authNode, namedNode(`${ACL_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));
  
  // Authorization: accessTo (the resource)
  quads.push(quad(authNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
  
  // Authorization: mode (Read access)
  quads.push(quad(authNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Read`)));

  // Convert quads to Turtle using N3 Writer
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acl: ACL_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Updates an existing ACL by adding public read access
 */
async function updateAclWithPublicAccess(
  existingTurtle: string,
  aclUrl: string,
  resourceUrl: string,
): Promise<string> {
  // Check if public access already exists
  if (hasPublicAccessAcl(existingTurtle)) {
    return existingTurtle; // Public access already exists
  }

  // Build new authorization for public access
  const { namedNode, blankNode, quad } = DataFactory;
  const quads: any[] = [];

  // Create Authorization for public access
  const authNode = blankNode('publicAuth');

  quads.push(quad(authNode, namedNode(`${RDF_NS}type`), namedNode(`${ACL_NS}Authorization`)));
  quads.push(quad(authNode, namedNode(`${ACL_NS}agentClass`), namedNode(`${FOAF_NS}Agent`)));
  quads.push(quad(authNode, namedNode(`${ACL_NS}accessTo`), namedNode(resourceUrl)));
  quads.push(quad(authNode, namedNode(`${ACL_NS}mode`), namedNode(`${ACL_NS}Read`)));

  // Convert new quads to Turtle
  const newTurtle = await new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: { acl: ACL_NS, rdf: RDF_NS, foaf: FOAF_NS } });
    quads.forEach((q) => writer.addQuad(q));
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  // Combine existing and new Turtle
  return existingTurtle + '\n' + newTurtle;
}

/**
 * Grants public read access to a Solid resource (anyone can read without authentication)
 * Automatically detects whether the Pod uses ACL or ACP and uses the appropriate method
 */
export async function grantPublicReadAccess(
  resourceUrl: string,
  session: SessionWithFetch | null,
): Promise<void> {
  if (!session || !session.fetch) {
    throw new Error('No authenticated session available. Please log in with Solid to grant access.');
  }

  const fetchFn = session.fetch;
  const { url: accessControlUrl, type } = await getAccessControlUrl(resourceUrl, fetchFn);

  // Fetch existing ACL/ACR or create new one
  const existingTurtle = await fetchAcr(accessControlUrl, fetchFn);
  let turtle: string;

  if (type === 'acl') {
    // Use ACL (Web Access Control)
    if (existingTurtle) {
      // Update existing ACL with public access
      turtle = await updateAclWithPublicAccess(existingTurtle, accessControlUrl, resourceUrl);
    } else {
      // Create new ACL with public access
      turtle = await createPublicAcl(resourceUrl, accessControlUrl);
    }
  } else {
    // Use ACP (Access Control Policy)
    if (existingTurtle) {
      // Update existing ACR with public access
      turtle = await updateAcrWithPublicAccess(existingTurtle, accessControlUrl);
    } else {
      // Create new ACR with public access
      turtle = await createPublicAcr(resourceUrl, accessControlUrl);
    }
  }

  // Save ACL/ACR
  const response = await fetchFn(accessControlUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
    },
    body: turtle,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to save ${type.toUpperCase()}: ${response.status} ${response.statusText} - ${errorText}`);
  }
}

/**
 * Grants read access to a Solid resource for the given WebIDs
 */
export async function grantReadAccess(
  resourceUrl: string,
  webIds: string[],
  session: SessionWithFetch | null,
): Promise<void> {
  if (webIds.length === 0) {
    return;
  }

  if (!session || !session.fetch) {
    throw new Error('No authenticated session available. Please log in with Solid to grant access.');
  }

  const fetchFn = session.fetch;
  const acrUrl = await getAcrUrl(resourceUrl, fetchFn);

  // Fetch existing ACR or create new one
  const existingTurtle = await fetchAcr(acrUrl, fetchFn);
  let turtle: string;

  if (existingTurtle) {
    // Update existing ACR
    turtle = await updateAcr(existingTurtle, acrUrl, webIds);
  } else {
    // Create new ACR
    turtle = await createAcr(resourceUrl, acrUrl, webIds);
  }

  // Save ACR
  const response = await fetchFn(acrUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
    },
    body: turtle,
  });

  if (!response.ok) {
    throw new Error(`Failed to save ACR: ${response.statusText}`);
  }
}

