<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;

final class CampaignPollsResourceTest extends TestCase
{
    private const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
    private const REVISION_ID = '22222222-2222-4222-8222-222222222222';
    private const POLL_ID = '33333333-3333-4333-8333-333333333333';
    private const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    protected function setUp(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testMaterializeListAndTallyUseAuthoritativePrivateRoutesAndShapes(): void
    {
        $definition = [
            'id' => self::POLL_ID,
            'campaign_id' => self::CAMPAIGN_ID,
            'content_revision_id' => self::REVISION_ID,
            'content_revision_source_hash' => self::HASH,
            'poll_contract_sha256' => self::HASH,
            'poll_key' => 'venue:primary',
            'question' => 'Which venue?',
            'two_step_required' => false,
            'closes_at' => '2026-09-01T12:00:00Z',
            'options' => [
                ['option_key' => 'north', 'label' => 'North hall', 'position' => 0],
                ['option_key' => 'south', 'label' => 'South hall', 'position' => 1],
            ],
            'created_at' => '2026-08-30T00:00:00Z',
        ];
        $tally = [
            'poll_id' => self::POLL_ID,
            'poll_key' => 'venue:primary',
            'content_revision_id' => self::REVISION_ID,
            'question' => 'Which venue?',
            'options' => [
                ['option_key' => 'north', 'label' => 'North hall', 'counted' => 2],
                ['option_key' => 'south', 'label' => 'South hall', 'counted' => 1],
            ],
            'machine_excluded' => 4,
            'unclassified_excluded' => 9,
            'voided_multi_option' => 3,
            'superseded_choices' => 2,
            'previewed_only' => 12,
            'submission_receipts' => 31,
        ];
        $server = LoopbackJsonServer::start([
            ['status' => 201, 'body' => $definition],
            ['body' => ['items' => [$definition], 'next_cursor' => 'pwcp1.next']],
            ['body' => $tally],
        ]);
        $client = new Client('pw_campaign_polls', "http://127.0.0.1:$server->port");

        $created = $client->campaignPolls->materialize(self::CAMPAIGN_ID, [
            'content_revision_id' => self::REVISION_ID,
            'poll_key' => 'venue:primary',
            'two_step_required' => false,
            'closes_at' => '2026-09-01T12:00:00Z',
        ]);
        $listed = $client->campaignPolls->list(self::CAMPAIGN_ID, [
            'limit' => 25,
            'cursor' => 'pwcp1.a2lk.payload.signature',
        ]);
        $result = $client->campaignPolls->tally(self::CAMPAIGN_ID, 'venue:primary');
        $requests = $server->requests();

        $base = '/api/v1/campaigns/' . self::CAMPAIGN_ID . '/polls';
        $this->assertSame([
            ['POST', $base],
            ['GET', $base . '?limit=25&cursor=pwcp1.a2lk.payload.signature'],
            ['GET', $base . '/venue%3Aprimary/tally'],
        ], array_map(
            static fn(array $request): array => [$request['method'], $request['target']],
            $requests
        ));
        foreach ($requests as $request) {
            $this->assertSame('Bearer pw_campaign_polls', $request['headers']['authorization']);
        }
        $this->assertSame([
            'content_revision_id' => self::REVISION_ID,
            'poll_key' => 'venue:primary',
            'two_step_required' => false,
            'closes_at' => '2026-09-01T12:00:00Z',
        ], json_decode($requests[0]['body'], true));
        $this->assertSame(self::REVISION_ID, $created['content_revision_id']);
        $this->assertCount(1, $listed['items']);
        $this->assertSame('pwcp1.next', $listed['next_cursor']);
        $this->assertSame(9, $result['unclassified_excluded']);
        $this->assertSame(2, $result['superseded_choices']);
        $this->assertSame(31, $result['submission_receipts']);
        $this->assertArrayNotHasKey('tenant_id', $result);
    }

    public function testMaterializationRejectsCallerAuthoredMeaningBeforeTransport(): void
    {
        $client = new Client('pw_campaign_polls', 'http://127.0.0.1:1');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('question and options come from the semantic AST');
        $client->campaignPolls->materialize(self::CAMPAIGN_ID, [
            'content_revision_id' => self::REVISION_ID,
            'poll_key' => 'venue',
            'question' => 'Caller-authored question',
            'options' => [['option_key' => 'forged', 'label' => 'Forged']],
        ]);
    }

    public function testPollInputValidationRejectsUnstableReferencesAndWrongRuntimeTypes(): void
    {
        $client = new Client('pw_campaign_polls', 'http://127.0.0.1:1');
        $effects = [
            static fn() => $client->campaignPolls->tally(self::CAMPAIGN_ID, 'not/a/reference'),
            static fn() => $client->campaignPolls->materialize(self::CAMPAIGN_ID, [
                'content_revision_id' => 'not-a-uuid',
                'poll_key' => 'venue',
            ]),
            static fn() => $client->campaignPolls->materialize(self::CAMPAIGN_ID, [
                'content_revision_id' => self::REVISION_ID,
                'poll_key' => 'venue',
                'two_step_required' => 'false',
            ]),
            static fn() => $client->campaignPolls->materialize(self::CAMPAIGN_ID, [
                'content_revision_id' => self::REVISION_ID,
                'poll_key' => 'venue',
                'closes_at' => 'tomorrow',
            ]),
            static fn() => $client->campaignPolls->list(self::CAMPAIGN_ID, ['limit' => 101]),
            static fn() => $client->campaignPolls->list(
                self::CAMPAIGN_ID,
                ['cursor' => 'not a cursor']
            ),
        ];

        foreach ($effects as $effect) {
            try {
                $effect();
                $this->fail('Malformed campaign poll input must fail before transport');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
