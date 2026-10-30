<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\ServerError;

final class CampaignAssuranceTransportTest extends TestCase
{
    private const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
    private const RUN_ID = '22222222-2222-4222-8222-222222222222';
    private const FINDING_ID = '33333333-3333-4333-8333-333333333333';
    private const REVISION_ID = '44444444-4444-4444-8444-444444444444';
    private const PLAN_ID = '55555555-5555-4555-8555-555555555555';
    private const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

    protected function setUp(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testEveryAssuranceRouteUsesExactBodiesHeadersPagingAndResponseEtag(): void
    {
        $envelope = [
            'measurement' => [
                'name' => 'Predicted Agent Comprehension',
                'interpretation' => 'A prediction, not a private inbox observation.',
                'source_classes' => [
                    ['class' => 'deterministic', 'present' => true, 'meaning' => 'rule-based'],
                    ['class' => 'modeled', 'present' => false, 'meaning' => 'prediction only'],
                    ['class' => 'controlled_observation', 'present' => false, 'meaning' => 'named seed only'],
                ],
            ],
            'data' => [],
        ];
        $responses = [
            [
                'body' => ['id' => self::CAMPAIGN_ID, 'status' => 'draft'],
                'headers' => ['ETag' => '"campaign-next-version"'],
            ],
            [
                'body' => ['id' => self::CAMPAIGN_ID, 'status' => 'draft'],
                'headers' => ['ETag' => '"campaign-cleared-version"'],
            ],
            ['status' => 202, 'body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['body' => $envelope],
            ['status' => 201, 'body' => $envelope],
            ['body' => $envelope],
        ];
        $server = LoopbackJsonServer::start($responses);
        $client = new Client('pw_assurance_transport', "http://127.0.0.1:$server->port");

        $contract = self::factContract();
        $set = $client->campaignAssurance->setFactContract(
            self::CAMPAIGN_ID,
            $contract,
            '"campaign-reviewed-version"',
            'fact-contract-set'
        );
        $cleared = $client->campaignAssurance->setFactContract(
            self::CAMPAIGN_ID,
            [],
            '"campaign-next-version"'
        );
        $client->campaignAssurance->createRun(
            self::CAMPAIGN_ID,
            [
                'profile' => 'full',
                'content_revision_id' => self::REVISION_ID,
                'send_plan_id' => self::PLAN_ID,
                'request_id' => self::REQUEST_ID,
            ],
            'assurance-create'
        );
        $client->campaignAssurance->getLatest(self::CAMPAIGN_ID);
        $client->campaignAssurance->getRun(self::CAMPAIGN_ID, self::RUN_ID);
        $client->campaignAssurance->getManifest(self::CAMPAIGN_ID, self::RUN_ID);
        $client->campaignAssurance->getEvidence(
            self::CAMPAIGN_ID,
            self::RUN_ID,
            ['offset' => 20, 'limit' => 50]
        );
        $events = $client->campaignAssurance->getEvents(self::CAMPAIGN_ID, self::RUN_ID);
        $client->campaignAssurance->appealFinding(
            self::CAMPAIGN_ID,
            self::RUN_ID,
            self::FINDING_ID,
            [
                'request_id' => self::REQUEST_ID,
                'decision' => 'allow_send',
                'reason' => 'Reviewed bounded evidence',
            ],
            'assurance-appeal'
        );
        $client->campaignAssurance->overrideFinding(
            self::CAMPAIGN_ID,
            self::RUN_ID,
            self::FINDING_ID,
            [
                'request_id' => self::REQUEST_ID,
                'decision' => 'reject',
                'reason' => 'Rejected after evidence review',
            ],
            'assurance-override'
        );
        $client->campaignAssurance->applyFinding(
            self::CAMPAIGN_ID,
            self::RUN_ID,
            self::FINDING_ID,
            [
                'request_id' => self::REQUEST_ID,
                'typed_patch' => ['operation' => 'replace_subject', 'value' => 'not transported'],
            ],
            '"campaign-reviewed-version"',
            'assurance-apply'
        );
        $client->campaignAssurance->cancelRun(self::CAMPAIGN_ID, self::RUN_ID);

        $requests = $server->requests();
        $base = '/api/v1/campaigns/' . self::CAMPAIGN_ID;
        $run = $base . '/assurance-runs/' . self::RUN_ID;
        $finding = $run . '/findings/' . self::FINDING_ID;

        $this->assertSame(self::CAMPAIGN_ID, $set['campaign']['id']);
        $this->assertSame('"campaign-next-version"', $set['etag']);
        $this->assertSame('"campaign-cleared-version"', $cleared['etag']);
        $this->assertFalse($events['measurement']['source_classes'][1]['present']);
        $this->assertSame([
            ['PUT', $base . '/fact-contract'],
            ['PUT', $base . '/fact-contract'],
            ['POST', $base . '/assurance-runs'],
            ['GET', $base . '/assurance'],
            ['GET', $run],
            ['GET', $run . '/manifest'],
            ['GET', $run . '/evidence?limit=50&offset=20'],
            ['GET', $run . '/events'],
            ['POST', $finding . '/appeals'],
            ['POST', $finding . '/overrides'],
            ['POST', $finding . '/apply'],
            ['POST', $run . '/cancel'],
        ], array_map(
            static fn(array $request): array => [$request['method'], $request['target']],
            $requests
        ));

        foreach ($requests as $request) {
            $this->assertSame('Bearer pw_assurance_transport', $request['headers']['authorization']);
        }
        $this->assertSame('"campaign-reviewed-version"', $requests[0]['headers']['if-match']);
        $this->assertSame('fact-contract-set', $requests[0]['headers']['idempotency-key']);
        $this->assertSame($contract, json_decode($requests[0]['body'], true));
        $this->assertSame('{}', $requests[1]['body']);
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D',
            $requests[1]['headers']['idempotency-key']
        );
        $this->assertSame('assurance-create', $requests[2]['headers']['idempotency-key']);
        $this->assertSame([
            'profile' => 'full',
            'content_revision_id' => self::REVISION_ID,
            'send_plan_id' => self::PLAN_ID,
            'request_id' => self::REQUEST_ID,
        ], json_decode($requests[2]['body'], true));
        $this->assertSame('assurance-appeal', $requests[8]['headers']['idempotency-key']);
        $this->assertSame('assurance-override', $requests[9]['headers']['idempotency-key']);
        $this->assertSame('assurance-apply', $requests[10]['headers']['idempotency-key']);
        $this->assertSame('"campaign-reviewed-version"', $requests[10]['headers']['if-match']);
        $this->assertSame(
            ['request_id' => self::REQUEST_ID],
            json_decode($requests[10]['body'], true)
        );
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D',
            $requests[11]['headers']['idempotency-key']
        );
        $this->assertSame('', $requests[11]['body']);
    }

    public function testControlledObservationRequestSurfacesStableUnavailableWithoutRunEvidence(): void
    {
        $server = LoopbackJsonServer::start([
            [
                'status' => 503,
                'body' => [
                    'error' => [
                        'code' => 'controlled_observation_unavailable',
                        'message' => 'No controlled-client adapter is configured.',
                        'retryable' => false,
                        'source_class' => 'controlled_observation',
                    ],
                ],
            ],
        ]);
        $client = new Client('pw_assurance_seed_unavailable', "http://127.0.0.1:$server->port");

        try {
            $client->campaignAssurance->createRun(
                self::CAMPAIGN_ID,
                [
                    'profile' => 'full',
                    'request_id' => self::REQUEST_ID,
                    'include_seed_test' => true,
                    'observed_surfaces' => ['gmail.seed'],
                ],
                'assurance-controlled-observation'
            );
            $this->fail('Unavailable controlled observation must not yield a run receipt');
        } catch (ServerError $error) {
            $this->assertSame(503, $error->status);
            $this->assertSame('controlled_observation_unavailable', $error->code);
        }
        $requests = $server->requests();
        $this->assertCount(1, $requests);
        $this->assertSame([
            'profile' => 'full',
            'request_id' => self::REQUEST_ID,
            'include_seed_test' => true,
            'observed_surfaces' => ['gmail.seed'],
        ], json_decode($requests[0]['body'], true));
    }

    public function testFactContractSuccessWithoutNextStrongEtagFailsClosed(): void
    {
        $server = LoopbackJsonServer::start([
            ['body' => ['id' => self::CAMPAIGN_ID]],
        ]);
        $client = new Client('pw_assurance_etag', "http://127.0.0.1:$server->port");

        try {
            $client->campaignAssurance->setFactContract(
                self::CAMPAIGN_ID,
                [],
                '"campaign-reviewed-version"'
            );
            $this->fail('Missing response ETag must fail closed');
        } catch (\UnexpectedValueException $error) {
            $this->assertStringContainsString('valid strong campaign ETag', $error->getMessage());
        } finally {
            $server->requests();
        }
    }

    /** @return array<string, mixed> */
    private static function factContract(): array
    {
        return [
            'schema_version' => 1,
            'primary_intent' => ['kind' => 'invite', 'statement' => 'Invite customers'],
            'audience_context' => ['description' => 'Existing Pro customers'],
            'core_claim' => ['statement' => 'The webinar demonstrates automation'],
            'primary_action' => [
                'action_id' => 'register',
                'block_id' => 'cta',
                'role' => 'register',
                'label' => 'Reserve my seat',
                'canonical_url' => 'https://example.test/events/launch',
            ],
            'required_facts' => [],
            'forbidden_claims' => [],
            'allowed_secondary_actions' => ['unsubscribe'],
            'language' => 'en-IN',
        ];
    }
}
