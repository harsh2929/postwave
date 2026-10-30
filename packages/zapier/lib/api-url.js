const DEFAULT_BASE_URL = 'https://api.moosewave.com';
const BLOCKED_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normalizeApiBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE_URL).trim();
  if (!value || CONTROL_RE.test(value)) {
    return DEFAULT_BASE_URL;
  }

  try {
    const url = new URL(value.replace(/\/+$/, ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') {
      return DEFAULT_BASE_URL;
    }
    if (url.username || url.password || url.search || url.hash) {
      return DEFAULT_BASE_URL;
    }
    if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
      return DEFAULT_BASE_URL;
    }
    if (isPrivateOrMetadataHost(host)) {
      return DEFAULT_BASE_URL;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function isPrivateOrMetadataHost(host) {
  const normalized = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
    if (/^fe80:/i.test(normalized)) return true;
  }

  return false;
}

function apiUrl(baseRaw, path) {
  const base = normalizeApiBaseUrl(baseRaw);
  const rawPath = String(path || '');
  if (rawPath.trim() !== rawPath || CONTROL_RE.test(rawPath) || rawPath.includes('\\')) {
    return apiUrl(base, '');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith('//')) {
    return apiUrl(base, '');
  }
  const relativePath = rawPath.replace(/^\/+/, '');
  if (relativePath.includes('#')) {
    return apiUrl(base, '');
  }
  const pathPart = relativePath.split('?')[0];
  if (pathPart.split('/').some((segment) => isUnsafePathSegment(segment))) {
    return apiUrl(base, '');
  }
  return new URL(`./${relativePath}`, `${base}/`).toString();
}

function isUnsafePathSegment(segment) {
  let current = String(segment || '');
  for (let i = 0; i < 2; i += 1) {
    const lower = current.toLowerCase();
    if (
      current === '.' ||
      current === '..' ||
      lower === '%2e' ||
      lower === '%2e.' ||
      lower === '.%2e' ||
      lower === '%2e%2e' ||
      CONTROL_RE.test(current) ||
      current.includes('\\')
    ) {
      return true;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current === '.' || current === '..' || CONTROL_RE.test(current) || current.includes('\\');
}

function apiUrlForBundle(bundle, path) {
  const base = bundle && bundle.authData && bundle.authData.api_base_url;
  return apiUrl(base, path);
}

function safeHeaderValue(value) {
  const text = String(value || '');
  return Boolean(text) && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text);
}

function safeHeaderName(value) {
  return HEADER_NAME_RE.test(String(value || ''));
}

module.exports = {
  DEFAULT_BASE_URL,
  normalizeApiBaseUrl,
  apiUrl,
  apiUrlForBundle,
  isPrivateOrMetadataHost,
  safeHeaderName,
  safeHeaderValue,
};
