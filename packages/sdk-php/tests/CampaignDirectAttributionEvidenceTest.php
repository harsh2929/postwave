<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\CampaignDirectAttributionEvidenceContract;

final class CampaignDirectAttributionEvidenceTest extends TestCase
{
    private const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
    private const EVIDENCE_ID = '22222222-2222-4222-8222-222222222222';

    protected function setUp(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testOneEncodedReadPreservesNullableObservation(): void
    {
        $server = LoopbackJsonServer::start([['body' => self::page()]]);
        $client = new Client('pw_f04', "http://127.0.0.1:$server->port");

        $result = $client->campaigns->listDirectAttributionEvidence(
            'campaign/a b',
            ['limit' => 17, 'offset' => 4]
        );
        $requests = $server->requests();

        $this->assertCount(1, $requests);
        $this->assertSame('GET', $requests[0]['method']);
        $this->assertSame(
            '/api/v1/campaigns/campaign%2Fa%20b/direct-attribution-evidence?limit=17&offset=4',
            $requests[0]['target']
        );
        $this->assertSame('', $requests[0]['body']);
        $this->assertNull($result['items'][0]['linked_without_recorded_assignment_click']);
        $this->assertFalse($result['items'][0]['readership_proven']);
        $this->assertArrayNotHasKey('recipient', $result['items'][0]);
        $this->assertArrayNotHasKey('email', $result['items'][0]);
        $this->assertArrayNotHasKey('code', $result['items'][0]);
        $this->assertSame(self::page(), $result);
    }

    public function testStrictDecoderRejectsIdentityAndReadershipFields(): void
    {
        $identityLeak = self::page();
        $identityLeak['items'][0]['recipient_email'] = 'person@example.com';
        try {
            CampaignDirectAttributionEvidenceContract::decodePage($identityLeak);
            $this->fail('identity-bearing response must fail closed');
        } catch (\UnexpectedValueException $error) {
            $this->assertStringContainsString('fields', $error->getMessage());
        }

        $readershipClaim = self::page();
        $readershipClaim['items'][0]['readership_proven'] = true;
        $this->expectException(\UnexpectedValueException::class);
        $this->expectExceptionMessage('cannot prove readership');
        CampaignDirectAttributionEvidenceContract::decodePage($readershipClaim);
    }

    public function testStrictDecoderRejectsMismatchedProvenance(): void
    {
        $payload = self::page();
        $payload['items'][0]['attribution_scope'] = 'campaign';
        $this->expectException(\UnexpectedValueException::class);
        $this->expectExceptionMessage('provenance');
        CampaignDirectAttributionEvidenceContract::decodePage($payload);
    }

    public function testDecoderRejectsRemovedAggregatesAndDishonestCurrency(): void
    {
        $aggregate = self::page();
        $aggregate['summary']['code_revenue_cents'] = -25;
        try {
            CampaignDirectAttributionEvidenceContract::decodePage($aggregate);
            $this->fail('cross-currency scalar aggregate must fail closed');
        } catch (\UnexpectedValueException $error) {
            $this->assertStringContainsString('summary fields', $error->getMessage());
        }

        foreach (['usd', 'US', 'USDD'] as $currency) {
            $payload = self::page();
            $payload['items'][0]['currency'] = $currency;
            try {
                CampaignDirectAttributionEvidenceContract::decodePage($payload);
                $this->fail('dishonest currency must fail closed');
            } catch (\UnexpectedValueException $error) {
                $this->assertStringContainsString('currency provenance', $error->getMessage());
            }
        }

        $unspecifiedCurrency = self::page();
        $unspecifiedCurrency['items'][0]['amount_cents'] = 125;
        $decoded = CampaignDirectAttributionEvidenceContract::decodePage($unspecifiedCurrency);
        $this->assertSame(125, $decoded['items'][0]['amount_cents']);
        $this->assertSame('', $decoded['items'][0]['currency']);

        $nonMonetaryWithCurrency = self::page();
        $nonMonetaryWithCurrency['items'][0]['currency'] = 'USD';
        $decoded = CampaignDirectAttributionEvidenceContract::decodePage($nonMonetaryWithCurrency);
        $this->assertNull($decoded['items'][0]['amount_cents']);
        $this->assertSame('USD', $decoded['items'][0]['currency']);
    }

    public function testDecoderRejectsHostileFormatsAndMissingFields(): void
    {
        $cases = [];
        $payload = self::page();
        $payload['campaign_id'] = 'not-a-uuid';
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['evidence_id'] = 'not-a-uuid';
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['status'] = '   ';
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['occurred_at'] = '2026-02-30T12:00:00Z';
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['occurred_at'] = '2026-08-30T12:00:00+24:00';
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['occurred_at'] = '2026-08-30T24:00:00Z';
        $cases[] = $payload;
        $payload = self::page();
        $payload['summary']['code_allocations'] = -1;
        $cases[] = $payload;
        $payload = self::page();
        $payload['summary']['code_allocations'] = 1.5;
        $cases[] = $payload;
        $payload = self::page();
        $payload['summary']['code_allocations'] = null;
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['conversion_id'] = 0;
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['linked_without_recorded_assignment_click'] = 0;
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['currency'] = null;
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'][0]['readership_proven'] = 0;
        $cases[] = $payload;
        $payload = self::page();
        $payload['items'] = null;
        $cases[] = $payload;
        $payload = self::page();
        $payload['page_info']['has_more'] = false;
        $cases[] = $payload;
        $payload = self::page();
        unset($payload['items'][0]['expires_at']);
        $cases[] = $payload;

        foreach ($cases as $payload) {
            try {
                CampaignDirectAttributionEvidenceContract::decodePage($payload);
                $this->fail('hostile or incomplete response must fail closed');
            } catch (\UnexpectedValueException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testDecoderRejectsContradictoryAuthoritativeReceipts(): void
    {
        foreach ([
            ['code_redemptions' => 7],
            ['code_linked_outcomes' => 7],
            ['no_click_redemptions' => 1],
            ['vanity_visits' => 1, 'vanity_linked_outcomes' => 2],
        ] as $mutation) {
            $payload = self::page();
            $payload['summary'] = array_replace($payload['summary'], $mutation);
            try {
                CampaignDirectAttributionEvidenceContract::decodePage($payload);
                $this->fail('contradictory summary must fail closed');
            } catch (\UnexpectedValueException $error) {
                $this->assertStringContainsString('inconsistent', $error->getMessage());
            }
        }

        $payload = self::page();
        $payload['page_info']['total'] = 7;
        try {
            CampaignDirectAttributionEvidenceContract::decodePage($payload);
            $this->fail('contradictory total must fail closed');
        } catch (\UnexpectedValueException $error) {
            $this->assertStringContainsString('page_info', $error->getMessage());
        }
    }

    public function testPaginationBoundsFailBeforeTransport(): void
    {
        $client = new Client('pw_f04', 'http://127.0.0.1:1');
        foreach ([
            ['limit' => 0],
            ['limit' => 101],
            ['offset' => -1],
            ['offset' => 10_001],
        ] as $options) {
            try {
                $client->campaigns->listDirectAttributionEvidence(self::CAMPAIGN_ID, $options);
                $this->fail('invalid pagination must fail before transport');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    /** @return array<string, mixed> */
    private static function page(): array
    {
        return [
            'campaign_id' => self::CAMPAIGN_ID,
            'summary' => [
                'code_allocations' => 6,
                'code_redemptions' => 1,
                'code_linked_outcomes' => 0,
                'no_click_redemptions' => 0,
                'with_click_redemptions' => 0,
                'click_evidence_unavailable' => 1,
                'vanity_visits' => 0,
                'vanity_linked_outcomes' => 0,
            ],
            'items' => [[
                'kind' => 'code_allocation',
                'evidence_id' => self::EVIDENCE_ID,
                'occurred_at' => '2026-08-30T12:00:00Z',
                'status' => 'redeemed',
                'expires_at' => null,
                'redeemed_at' => '2026-08-30T12:05:00Z',
                'redemption_id' => 41,
                'conversion_id' => null,
                'amount_cents' => null,
                'currency' => '',
                'attributed_via' => 'code_redemption',
                'attribution_scope' => 'campaign_assignment',
                'linked_without_recorded_assignment_click' => null,
                'readership_proven' => false,
            ]],
            'page_info' => ['limit' => 17, 'offset' => 4, 'total' => 6, 'has_more' => true],
        ];
    }
}
