<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\ServerError;

final class NativeIntegrationFamilyResource extends Resource
{
    public const SUPPORT_INTEGRATION_RUNTIME_HELD_CODE = 'support_integration_runtime_held';

    public function __construct(
        \Moosewave\Client $client,
        private string $providersPath,
        private string $integrationsPath,
        private bool $supportsIngest = false,
        private ?string $runtimeHoldCode = null
    ) {
        parent::__construct($client);
    }

    /** @return array<string, mixed> */
    public function providers(): array
    {
        $out = $this->client->request('GET', $this->providersPath);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function oauthAvailability(string $provider): array
    {
        $this->requireCrmOAuthSupport();
        $out = $this->client->request(
            'GET',
            '/api/v1/crm/' . self::crmOAuthProviderSegment($provider) . '/oauth/availability'
        );
        return is_array($out) ? $out : [];
    }

    /** @param array<string, mixed> $query */
    public function oauthStartUrl(string $provider, array $query = []): string
    {
        $this->requireCrmOAuthSupport();
        $path = '/api/v1/crm/' . self::crmOAuthProviderSegment($provider) . '/oauth/start';
        $filtered = array_filter(
            $query,
            static fn($value): bool => $value !== null && $value !== ''
        );
        if ($filtered === []) {
            return $path;
        }
        $normalized = array_map(
            static fn($value): mixed => is_bool($value) ? ($value ? 'true' : 'false') : $value,
            $filtered
        );
        return $path . '?' . http_build_query($normalized, '', '&', PHP_QUERY_RFC3986);
    }

    /**
     * @param array{limit?: int, cursor?: string} $options
     * @return array<string, mixed>
     */
    public function list(array $options = []): array
    {
        if ($this->runtimeHoldCode === null && $options !== []) {
            throw new \InvalidArgumentException(
                'native integration list pagination is available only for support integrations'
            );
        }
        $query = $this->runtimeHoldCode === null ? [] : self::supportListQuery($options);
        $out = $this->client->request('GET', $this->integrationsPath, null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function create(array $payload): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request('POST', $this->integrationsPath, $payload);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request(
            'GET',
            $this->integrationsPath . '/' . $this->readIntegrationIdSegment($id)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function sync(string $id, array $payload): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'POST',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id') . '/sync',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function backfill(string $id, array $payload): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'POST',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id') . '/backfill',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function ingest(string $id, array $payload): array
    {
        $this->assertRuntimeAvailable();
        if (!$this->supportsIngest) {
            throw new \InvalidArgumentException('native integration family does not support ingest');
        }
        $out = $this->client->request(
            'POST',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id') . '/ingest',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pause(string $id): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'POST',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id') . '/pause'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function disconnect(string $id): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'DELETE',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id')
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public function acknowledgeProviderCleanup(string $id, array $payload): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'POST',
            $this->integrationsPath . '/' . IntegrationsResource::pathSegment($id, 'native integration id') . '/provider-cleanup/acknowledge',
            $payload
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function runs(string $id, int $limit = 25): array
    {
        $this->assertRuntimeAvailable();
        $out = $this->client->request(
            'GET',
            $this->integrationsPath . '/' . $this->readIntegrationIdSegment($id) . '/runs',
            null,
            ['limit' => $limit]
        );
        return is_array($out) ? $out : [];
    }

    private function requireCrmOAuthSupport(): void
    {
        if ($this->providersPath !== '/api/v1/crm/providers') {
            throw new \InvalidArgumentException('native integration family does not support managed CRM OAuth');
        }
    }

    private function assertRuntimeAvailable(): void
    {
        if ($this->runtimeHoldCode === null) {
            return;
        }
        throw new ServerError(
            'Support-provider connection configuration, synchronization, ingestion, lifecycle mutations, and run history are release-held while Helpdesk privacy governance is incomplete.',
            $this->runtimeHoldCode,
            503
        );
    }

    private function readIntegrationIdSegment(string $id): string
    {
        if ($this->runtimeHoldCode === null) {
            return IntegrationsResource::pathSegment($id, 'native integration id');
        }
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $id) !== 1) {
            throw new \InvalidArgumentException('support integration id must be a lowercase canonical UUID');
        }
        return $id;
    }

    /**
     * @param array{limit?: int, cursor?: string} $options
     * @return array{limit?: int, cursor?: string}
     */
    private static function supportListQuery(array $options): array
    {
        $unknown = array_diff_key($options, ['limit' => true, 'cursor' => true]);
        if ($unknown !== []) {
            throw new \InvalidArgumentException('support integration list accepts only limit and cursor');
        }

        $query = [];
        if (array_key_exists('limit', $options)) {
            $limit = $options['limit'];
            if (!is_int($limit) || $limit < 1 || $limit > 100) {
                throw new \InvalidArgumentException(
                    'support integration limit must be an integer from 1 through 100'
                );
            }
            $query['limit'] = $limit;
        }
        if (array_key_exists('cursor', $options)) {
            $cursor = $options['cursor'];
            $validUtf8 = is_string($cursor) && preg_match('//u', $cursor) === 1;
            $hasUnsafeControls = $validUtf8
                && preg_match(
                    '/[\x{0000}-\x{001F}\x{007F}-\x{009F}\x{061C}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{206F}\x{FEFF}]/u',
                    $cursor
                ) === 1;
            if (
                !$validUtf8
                || $cursor === ''
                || $cursor !== trim($cursor)
                || strlen($cursor) > 4096
                || $hasUnsafeControls
            ) {
                throw new \InvalidArgumentException('support integration cursor is invalid');
            }
            $query['cursor'] = $cursor;
        }
        return $query;
    }

    private static function crmOAuthProviderSegment(string $provider): string
    {
        $value = strtolower(trim($provider));
        $supported = ['pipedrive', 'hubspot', 'salesforce', 'zoho', 'dynamics365', 'keap', 'gohighlevel'];
        if (!in_array($value, $supported, true)) {
            throw new \InvalidArgumentException("Unsupported CRM OAuth provider: $provider");
        }
        return rawurlencode($value);
    }
}
