<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

final class CampaignsResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(string $query = ''): array
    {
        $q = $query === '' ? [] : ['query' => $query];
        $out = $this->client->request('GET', '/api/v1/campaigns', null, $q);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/campaigns/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * Return exactly one bounded, read-only page of audited campaign linkage
     * evidence. No allocation or redemption mutation is exposed here.
     *
     * @param array{limit?: int, offset?: int} $options
     * @return array<string, mixed>
     */
    public function listDirectAttributionEvidence(string $campaignId, array $options = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaigns/'
                . CampaignDirectAttributionEvidenceContract::campaignSegment($campaignId)
                . '/direct-attribution-evidence',
            null,
            CampaignDirectAttributionEvidenceContract::listQuery($options)
        );
        return CampaignDirectAttributionEvidenceContract::decodePage($out);
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function create(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/campaigns', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch): array
    {
        $out = $this->client->request('PATCH', '/api/v1/campaigns/' . rawurlencode($id), $patch);
        return is_array($out) ? $out : [];
    }

    public function delete(string $id): void
    {
        $this->client->request('DELETE', '/api/v1/campaigns/' . rawurlencode($id));
    }

    /**
     * Queue a campaign through the production lifecycle (compliance,
     * approval gating, suppression filtering). When $sandbox is true the
     * send is simulated via the X-Postwave-Sandbox header — no live send.
     *
     * @return array<string, mixed>
     */
    public function queue(string $id, bool $sandbox = false): array
    {
        $headers = $sandbox ? ['X-Postwave-Sandbox' => 'true'] : [];
        $out = $this->client->request('POST', '/api/v1/campaigns/' . rawurlencode($id) . '/queue', null, [], $headers);
        return is_array($out) ? $out : [];
    }

    /**
     * Immediate send (Listmonk handoff). May return an approval-required
     * response when the campaign has not yet been approved.
     *
     * @return array<string, mixed>
     */
    public function send(string $id, bool $sandbox = false): array
    {
        $headers = $sandbox ? ['X-Postwave-Sandbox' => 'true'] : [];
        $out = $this->client->request('POST', '/api/v1/campaigns/' . rawurlencode($id) . '/send', null, [], $headers);
        return is_array($out) ? $out : [];
    }

    /**
     * Pause a campaign that is currently `sending` or `scheduled`.
     * Returns the updated campaign. The server rejects (409) campaigns
     * that are not in a pausable state.
     *
     * @return array<string, mixed>
     */
    public function pause(string $id): array
    {
        $out = $this->client->request('POST', '/api/v1/campaigns/' . rawurlencode($id) . '/pause');
        return is_array($out) ? $out : [];
    }

    /**
     * Resume a `paused` campaign, returning it to `sending`. Returns 423
     * (Locked) when the tenant's email kill switch is engaged.
     *
     * @return array<string, mixed>
     */
    public function resume(string $id): array
    {
        $out = $this->client->request('POST', '/api/v1/campaigns/' . rawurlencode($id) . '/resume');
        return is_array($out) ? $out : [];
    }

    /**
     * Cancel a campaign that is `draft`, `scheduled`, `sending`, or
     * `paused`, transitioning it to `cancelled`. Returns the updated campaign.
     *
     * @return array<string, mixed>
     */
    public function cancel(string $id): array
    {
        $out = $this->client->request('POST', '/api/v1/campaigns/' . rawurlencode($id) . '/cancel');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{campaign_id?: string, to_email: string, subject?: string, body_html?: string, body_mjml?: string} $input
     * @return array<string, mixed>
     */
    public function sendTest(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/campaigns/test-send', $input);
        return is_array($out) ? $out : [];
    }
}
