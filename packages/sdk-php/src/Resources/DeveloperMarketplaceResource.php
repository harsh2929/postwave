<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class DeveloperMarketplaceResource extends Resource
{
    /**
     * @return array<string, mixed>
     */
    public function catalog(): array
    {
        $out = $this->client->request('GET', '/api/v1/developer-marketplace/catalog');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function validateApp(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/validate',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listApps(?string $status = null): array
    {
        $query = [];
        if ($status !== null && trim($status) !== '') {
            $query['status'] = $status;
        }
        $out = $this->client->request('GET', '/api/v1/developer-marketplace/apps', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createApp(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/developer-marketplace/apps', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function getApp(string $appId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function updateApp(string $appId, array $input): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId),
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function submitAppReview(string $appId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/submit-review'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function monitoring(string $appId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/monitoring'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listOAuthClients(string $appId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/oauth-clients'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createOAuthClient(string $appId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/oauth-clients',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function revokeOAuthClient(string $appId, string $clientId): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/oauth-clients/' . rawurlencode($clientId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listTestAccounts(string $appId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/test-accounts'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createTestAccount(string $appId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/test-accounts',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listListings(?string $category = null): array
    {
        $query = [];
        if ($category !== null && trim($category) !== '') {
            $query['category'] = $category;
        }
        $out = $this->client->request('GET', '/api/v1/developer-marketplace/listings', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function upsertListing(string $appId, array $input): array
    {
        $out = $this->client->request(
            'PUT',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/listing',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function submitListingReview(string $appId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/listing/submit-review'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listInstallations(?string $status = null): array
    {
        $query = [];
        if ($status !== null && trim($status) !== '') {
            $query['status'] = $status;
        }
        $out = $this->client->request('GET', '/api/v1/developer-marketplace/installations', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function installApp(string $appId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/installations',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function revokeInstallation(string $installationId): array
    {
        $out = $this->client->request(
            'DELETE',
            '/api/v1/developer-marketplace/installations/' . rawurlencode($installationId)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listWebhookSubscriptions(string $appId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/webhook-subscriptions'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createWebhookSubscription(string $appId, array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/apps/' . rawurlencode($appId) . '/webhook-subscriptions',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listPartnerProfiles(?string $profileType = null): array
    {
        $query = [];
        if ($profileType !== null && trim($profileType) !== '') {
            $query['profile_type'] = $profileType;
        }
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/partner-profiles',
            null,
            $query
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function upsertPartnerProfile(array $input): array
    {
        $out = $this->client->request(
            'PUT',
            '/api/v1/developer-marketplace/partner-profile',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function submitPartnerProfileReview(): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/partner-profile/submit-review'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $query
     * @return array<string, mixed>
     */
    public function reviewQueue(string $reviewSecret, array $query = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/developer-marketplace/review/queue',
            null,
            $query,
            self::reviewHeaders($reviewSecret)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function reviewAppDecision(string $appId, array $input, string $reviewSecret): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/review/apps/' . rawurlencode($appId) . '/decision',
            $input,
            [],
            self::reviewHeaders($reviewSecret)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function reviewListingDecision(string $appId, array $input, string $reviewSecret): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/review/apps/' . rawurlencode($appId) . '/listing/decision',
            $input,
            [],
            self::reviewHeaders($reviewSecret)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function reviewPartnerProfileDecision(string $tenantId, array $input, string $reviewSecret): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/review/partner-profiles/' . rawurlencode($tenantId) . '/decision',
            $input,
            [],
            self::reviewHeaders($reviewSecret)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{
     *   response_type: 'code',
     *   client_id: string,
     *   redirect_uri: string,
     *   state: string,
     *   code_challenge: string,
     *   code_challenge_method: 'S256',
     *   scope?: string,
     *   installed_by?: string
     * } $input
     * @return array<string, mixed>
     */
    public function authorize(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/oauth/authorize',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{
     *   grant_type: 'authorization_code',
     *   code: string,
     *   redirect_uri: string,
     *   client_id: string,
     *   client_secret: string,
     *   code_verifier: string
     * } $input
     * @return array<string, mixed>
     */
    public function token(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/oauth/token',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{token: string, client_id?: string, client_secret?: string} $input
     * @return array<string, mixed>
     */
    public function revoke(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/developer-marketplace/oauth/revoke',
            $input
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, mixed>
     */
    public function listAuditLogs(?string $appId = null): array
    {
        $query = [];
        if ($appId !== null && trim($appId) !== '') {
            $query['app_id'] = $appId;
        }
        $out = $this->client->request('GET', '/api/v1/developer-marketplace/audit-logs', null, $query);
        return is_array($out) ? $out : [];
    }

    /**
     * @return array<string, string>
     */
    private static function reviewHeaders(string $reviewSecret): array
    {
        return ['X-Postwave-Review-Secret' => $reviewSecret];
    }
}
