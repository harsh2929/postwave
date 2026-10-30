<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\CampaignAssuranceContract;
use Moosewave\Resources\CampaignAssuranceResource;
use Moosewave\Resources\CampaignPollsResource;

final class CampaignAssuranceContractTest extends TestCase
{
    private const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
    private const RUN_ID = '22222222-2222-4222-8222-222222222222';
    private const FINDING_ID = '33333333-3333-4333-8333-333333333333';
    private const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

    public function testClientMountsAssuranceAndPollResources(): void
    {
        $client = new Client('pw_test_assurance_surface');

        $this->assertInstanceOf(CampaignAssuranceResource::class, $client->campaignAssurance);
        $this->assertInstanceOf(CampaignPollsResource::class, $client->campaignPolls);
        foreach ([
            'setFactContract',
            'createRun',
            'run',
            'getLatest',
            'getRun',
            'getManifest',
            'getEvidence',
            'getEvents',
            'appealFinding',
            'appeal',
            'overrideFinding',
            'override',
            'applyFinding',
            'cancelRun',
        ] as $method) {
            $this->assertTrue(method_exists($client->campaignAssurance, $method), "Missing $method()");
        }
    }

    /** @return iterable<string, array{0: string}> */
    public static function invalidEtags(): iterable
    {
        yield 'empty' => [''];
        yield 'wildcard' => ['*'];
        yield 'weak' => ['W/"weak"'];
        yield 'list' => ['"one", "two"'];
        yield 'bare' => ['bare'];
        yield 'leading whitespace' => [' "padded"'];
        yield 'embedded quote' => ['"bad"quote"'];
        yield 'control' => ["\"bad\nvalue\""];
    }

    #[DataProvider('invalidEtags')]
    public function testConditionalWritesRejectAnythingExceptOneExactStrongEtag(string $ifMatch): void
    {
        $client = new Client('pw_test_assurance_validation', 'http://127.0.0.1:1');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('exact strong campaign ETag');
        $client->campaignAssurance->applyFinding(
            self::CAMPAIGN_ID,
            self::RUN_ID,
            self::FINDING_ID,
            ['request_id' => self::REQUEST_ID],
            $ifMatch,
            'apply-once'
        );
    }

    public function testMutationIdentityIsValidatedOrAutoMinted(): void
    {
        $this->assertSame('retry-key', CampaignAssuranceContract::idempotencyKey('retry-key'));
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D',
            CampaignAssuranceContract::idempotencyKey(null)
        );

        foreach ([" bad", "bad ", "bad\nkey", str_repeat('x', 256), "bad\xFF"] as $invalid) {
            try {
                CampaignAssuranceContract::idempotencyKey($invalid);
                $this->fail('Malformed idempotency key must be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('1-255 UTF-8 bytes', $error->getMessage());
            }
        }
    }

    public function testFactContractIsClosedAndTypeDirected(): void
    {
        $contract = self::factContract();
        $this->assertSame($contract, CampaignAssuranceContract::factContract($contract));
        $this->assertSame([], CampaignAssuranceContract::factContract([]));

        $withUnknown = $contract;
        $withUnknown['provider_observation'] = true;
        try {
            CampaignAssuranceContract::factContract($withUnknown);
            $this->fail('Unknown top-level Fact Contract fields must be rejected');
        } catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('unsupported field', $error->getMessage());
        }

        $wrongTypedValue = $contract;
        $wrongTypedValue['required_facts'][0] = [
            'id' => 'price',
            'type' => 'money',
            'display_value' => 'INR 99',
            'criticality' => 'critical',
            'source_block_ids' => ['price-block'],
            'text_value' => 'INR 99',
        ];
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('exactly the typed value field');
        CampaignAssuranceContract::factContract($wrongTypedValue);
    }

    public function testRunInputCarriesControlledObservationRequestWithoutClaimingAvailability(): void
    {
        $input = [
            'profile' => 'full',
            'request_id' => self::REQUEST_ID,
            'include_seed_test' => true,
            'observed_surfaces' => ['gmail.seed', 'outlook:controlled'],
        ];
        $this->assertSame($input, CampaignAssuranceContract::createRunInput($input));

        foreach ([
            [
                'profile' => 'full',
                'request_id' => self::REQUEST_ID,
                'observed_surfaces' => ['gmail.seed'],
            ],
            [
                'profile' => 'full',
                'request_id' => self::REQUEST_ID,
                'include_seed_test' => true,
                'observed_surfaces' => ['duplicate', 'duplicate'],
            ],
            [
                'profile' => 'full',
                'request_id' => self::REQUEST_ID,
                'include_seed_test' => true,
                'observed_surfaces' => ['not/a/stable/reference'],
            ],
        ] as $invalid) {
            try {
                CampaignAssuranceContract::createRunInput($invalid);
                $this->fail('Invalid controlled-observation request must be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('observed_surfaces', $error->getMessage());
            }
        }
    }

    public function testPagingAndGovernedDecisionBoundsFailBeforeTransport(): void
    {
        foreach ([['limit' => 0], ['limit' => 201], ['offset' => -1], ['offset' => 100001], ['cursor' => 'nope']] as $invalid) {
            try {
                CampaignAssuranceContract::evidenceQuery($invalid);
                $this->fail('Invalid evidence query must be rejected');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('10-2000 characters');
        CampaignAssuranceContract::appealInput([
            'request_id' => self::REQUEST_ID,
            'decision' => 'allow_send',
            'reason' => ' too short ',
        ]);
    }

    /** @return array<string, mixed> */
    private static function factContract(): array
    {
        return [
            'schema_version' => 1,
            'primary_intent' => [
                'kind' => 'invite',
                'statement' => 'Invite existing customers to the webinar',
            ],
            'audience_context' => ['description' => 'Existing Pro customers'],
            'core_claim' => [
                'statement' => 'The webinar demonstrates automation',
                'source_block_ids' => ['claim-block'],
            ],
            'primary_action' => [
                'action_id' => 'register',
                'block_id' => 'cta',
                'role' => 'register',
                'label' => 'Reserve my seat',
                'canonical_url' => 'https://example.test/events/launch',
            ],
            'required_facts' => [
                [
                    'id' => 'event-time',
                    'type' => 'datetime',
                    'display_value' => '2 September at 10:00 IST',
                    'criticality' => 'critical',
                    'source_block_ids' => ['event-time-block'],
                    'datetime_value' => [
                        'rfc3339' => '2026-09-02T10:00:00+05:30',
                        'timezone' => 'Asia/Kolkata',
                    ],
                ],
            ],
            'forbidden_claims' => [
                ['id' => 'no-guarantee', 'statement' => 'Do not promise guaranteed results'],
            ],
            'allowed_secondary_actions' => ['unsubscribe'],
            'language' => 'en-IN',
        ];
    }
}
