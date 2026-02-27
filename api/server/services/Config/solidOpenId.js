/**
 * Solid OpenID provider configuration.
 * Supports multiple issuers via SOLID_OPENID_PROVIDERS (JSON array).
 */

const defaultScope = process.env.SOLID_OPENID_SCOPE || 'openid webid offline_access';
const defaultCallbackPath =
  process.env.SOLID_OPENID_CALLBACK_URL || '/oauth/openid/callback';

/**
 * Default display labels for known issuers (used when provider config has no label).
 */
const KNOWN_ISSUER_LABELS = {
  'http://localhost:3000/': 'Local CSS',
  'http://localhost:3000': 'Local CSS',
  'https://solidcommunity.net/': 'Solid Community',
  'https://solidcommunity.net': 'Solid Community',
  'https://login.inrupt.com/': 'Inrupt',
  'https://login.inrupt.com': 'Inrupt',
};

/** Issuer URLs for the 3 default options shown in the login modal. */
const DEFAULT_ISSUER_OPTIONS = [
  { issuer: 'http://localhost:3000/', label: 'Local CSS' },
  { issuer: 'https://solidcommunity.net/', label: 'Solid Community' },
  { issuer: 'https://login.inrupt.com/', label: 'Inrupt' },
];

/**
 * Normalize issuer URL for comparison (trailing slash, no fragment).
 * @param {string} issuer
 * @returns {string}
 */
function normalizeIssuer(issuer) {
  if (!issuer || typeof issuer !== 'string') {
    return '';
  }
  const u = issuer.trim();
  if (!u) {
    return '';
  }
  try {
    const url = new URL(u.startsWith('http') ? u : `https://${u}`);
    url.hash = '';
    let path = url.pathname;
    if (!path.endsWith('/')) {
      path += '/';
    }
    return `${url.origin}${path}`;
  } catch {
    return u;
  }
}

/**
 * Get the list of configured Solid OpenID providers.
 * Each provider has: issuer, clientId, clientSecret, scope, label, callbackPath.
 * Configure via SOLID_OPENID_PROVIDERS (JSON array); each entry may have
 * issuer, clientId, clientSecret, scope (optional), label (optional).
 *
 * @returns {{ issuer: string, clientId: string, clientSecret: string, scope: string, label: string, callbackPath: string }[]}
 */
function getSolidOpenIdProviders() {
  const providers = [];

  if (process.env.SOLID_OPENID_PROVIDERS) {
    try {
      const parsed = JSON.parse(process.env.SOLID_OPENID_PROVIDERS);
      if (!Array.isArray(parsed)) {
        return providers;
      }
      for (const p of parsed) {
        const issuer = normalizeIssuer(p.issuer || p.url);
        if (!issuer || !p.clientId) {
          continue;
        }
        const label =
          p.label ||
          KNOWN_ISSUER_LABELS[issuer] ||
          KNOWN_ISSUER_LABELS[issuer.replace(/\/$/, '')] ||
          issuer;
        providers.push({
          issuer,
          clientId: String(p.clientId).trim(),
          clientSecret: (p.clientSecret && String(p.clientSecret).trim()) || '',
          scope: (p.scope && String(p.scope).trim()) || defaultScope,
          label,
          callbackPath: (p.callbackPath && String(p.callbackPath).trim()) || defaultCallbackPath,
        });
      }
    } catch (e) {
      // Invalid JSON
    }
  }

  return providers;
}

/**
 * Get provider list for solidJwt registration (startup or lazy).
 * When SOLID_OPENID_PROVIDERS is empty but SOLID_OPENID_CUSTOM_CLIENT_ID is set, returns one synthetic
 * provider for Local CSS so we can still register solidJwt (e.g. user picked "Local CSS" from modal).
 * @returns {{ issuer: string, clientId: string, clientSecret: string, scope: string, label: string, callbackPath: string }[]}
 */
function getSolidOpenIdProvidersForJwt() {
  const list = getSolidOpenIdProviders();
  if (list.length > 0) {
    return list;
  }
  if (process.env.SOLID_OPENID_CUSTOM_CLIENT_ID) {
    return [
      {
        issuer: 'http://localhost:3000/',
        clientId: process.env.SOLID_OPENID_CUSTOM_CLIENT_ID,
        clientSecret: process.env.SOLID_OPENID_CUSTOM_CLIENT_SECRET || '',
        scope: process.env.SOLID_OPENID_CUSTOM_SCOPE || defaultScope,
        label: 'Local CSS',
        callbackPath: defaultCallbackPath,
      },
    ];
  }
  return [];
}

/**
 * Check if an issuer URL is allowed for "custom" (https or http localhost).
 * @param {string} normalizedIssuer
 * @returns {boolean}
 */
function isAllowedCustomIssuer(normalizedIssuer) {
  if (!normalizedIssuer) return false;
  try {
    const url = new URL(normalizedIssuer);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
      return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Get provider config by issuer (must match normalized issuer).
 * If not in configured list, and SOLID_OPENID_CUSTOM_CLIENT_ID is set, returns a synthetic
 * "custom" provider for any allowed issuer URL (https or http localhost).
 * @param {string} issuer
 * @returns {{ issuer: string, clientId: string, clientSecret: string, scope: string, label: string, callbackPath: string } | null}
 */
function getSolidOpenIdProviderByIssuer(issuer) {
  const normalized = normalizeIssuer(issuer);
  const providers = getSolidOpenIdProviders();
  const configured = providers.find((p) => p.issuer === normalized);
  if (configured) return configured;

  // Custom issuer: use SOLID_OPENID_CUSTOM_* if set and URL is allowed
  if (
    process.env.SOLID_OPENID_CUSTOM_CLIENT_ID &&
    isAllowedCustomIssuer(normalized)
  ) {
    return {
      issuer: normalized,
      clientId: process.env.SOLID_OPENID_CUSTOM_CLIENT_ID,
      clientSecret: process.env.SOLID_OPENID_CUSTOM_CLIENT_SECRET || '',
      scope: process.env.SOLID_OPENID_CUSTOM_SCOPE || defaultScope,
      label: KNOWN_ISSUER_LABELS[normalized] || KNOWN_ISSUER_LABELS[normalized.replace(/\/$/, '')] || 'Custom',
      callbackPath: defaultCallbackPath,
    };
  }
  return null;
}

/**
 * Check if Solid OpenID is enabled (at least one provider or custom credentials configured).
 * @returns {boolean}
 */
function isSolidOpenIdEnabled() {
  return getSolidOpenIdProviders().length > 0 || !!process.env.SOLID_OPENID_CUSTOM_CLIENT_ID;
}

module.exports = {
  getSolidOpenIdProviders,
  getSolidOpenIdProvidersForJwt,
  getSolidOpenIdProviderByIssuer,
  isSolidOpenIdEnabled,
  normalizeIssuer,
  defaultScope,
  defaultCallbackPath,
  DEFAULT_ISSUER_OPTIONS,
};
