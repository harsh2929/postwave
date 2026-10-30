<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * ReferralsResource — referral program + per-subscriber view.
 * Mirrors packages/sdk-ts/src/resources/referrals.ts.
 */
final class ReferralsResource extends Resource
{
    /**
     * @deprecated Referral-program mutations are release-gated. Retained for
     * source compatibility; the server does not mount this operation.
     *
     * @param array<int, array{count: int, reward_label: string}> $milestones
     * @return array<string, mixed>
     */
    public function setProgram(array $milestones): array
    {
        $out = $this->client->request('POST', '/api/v1/referral-programs', ['milestones' => $milestones]);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function getProgram(): array
    {
        $out = $this->client->request('GET', '/api/v1/referral-programs/current');
        return is_array($out) ? $out : [];
    }

    /**
     * @deprecated Subscriber referral-link issuance is release-gated because
     * the legacy GET can mint a live attribution token.
     *
     * @return array<string, mixed>
     */
    public function subscriberView(string $subscriberId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/subscribers/' . rawurlencode($subscriberId) . '/referral'
        );
        return is_array($out) ? $out : [];
    }
}
