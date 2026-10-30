// Moosewave uses bearer-token API keys minted in the dashboard
// (https://app.moosewave.com/settings/api-keys). The Zapier auth flow is
// the lightest possible "custom" auth: collect the key (+ optional self-host
// base URL), then verify it by GETting /api/v1/auth/me.
//
// We deliberately don't use Zapier's "session" auth — there's no OAuth dance
// to set up, and forcing one would add a hosting requirement for callback
// URLs that isn't worth it for a server-side API-key product.

const { DEFAULT_BASE_URL, apiUrlForBundle } = require('./lib/api-url');
const { responseData } = require('./lib/fields');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'Moosewave API key',
      required: true,
      type: 'password',
      helpText: 'Generate at https://app.moosewave.com/settings/api-keys',
    },
    {
      key: 'api_base_url',
      label: 'API base URL',
      required: false,
      default: DEFAULT_BASE_URL,
      helpText: 'Override for self-hosted Moosewave deployments',
    },
  ],
  test: async (z, bundle) => {
    const response = await z.request({ url: apiUrlForBundle(bundle, '/api/v1/auth/me') });
    // Zapier's auth.test must return something truthy on success. Older z.request
    // versions returned `data`; newer ones (platform 12+) attach the parsed JSON
    // body on `response.data`. Fall back to `response.json` for safety.
    return responseData(response) || response;
  },
  connectionLabel: '{{tenant_slug}}',
};

module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
