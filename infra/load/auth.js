// Shared authentication boundary for k6 load scripts.
//
// A deployed environment must be exercised with the same bearer API-key path
// used by real clients. The development-only tenant/role headers are retained
// solely for loopback runs so local smoke tests remain convenient without
// teaching CI to rely on an authentication bypass.

const rawBase = (__ENV.POSTWAVE_LOAD_BASE_URL || 'http://localhost:8080').trim();

export const BASE = rawBase.replace(/\/+$/, '');

const IS_LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(BASE);
const API_KEY = (__ENV.POSTWAVE_LOAD_API_KEY || '').trim();

if (!IS_LOOPBACK && !/^https:\/\//i.test(BASE)) {
  throw new Error('remote load targets must use HTTPS');
}
if (!IS_LOOPBACK && !API_KEY) {
  throw new Error('POSTWAVE_LOAD_API_KEY is required for a remote load target');
}

export function authHeaders(extra = {}) {
  if (API_KEY) {
    return {
      Authorization: `Bearer ${API_KEY}`,
      ...extra,
    };
  }

  return {
    'X-Tenant-Slug': (__ENV.POSTWAVE_LOAD_TENANT_SLUG || 'demo').trim(),
    'X-Postwave-Role': 'admin',
    ...extra,
  };
}
