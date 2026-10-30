<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\PostwaveError;
use Moosewave\Errors\ServerError;
use Moosewave\Resources\SmsResource;

final class SmsEvidenceReleaseHoldTest extends TestCase
{
    public function testCampaignEvidenceMethodsFailLocallyWithoutIdentityLeak(): void
    {
        // Port 1 is intentionally unreachable. Receiving the stable hold error
        // proves neither method attempted an HTTP request.
        $client = new Client(
            'private-api-token',
            'http://127.0.0.1:1',
            1
        );
        $privateId = 'campaign/+15552345678/private-token';

        $calls = [
            static fn () => $client->sms->campaignReport($privateId),
            static fn () => $client->sms->exportCampaignReport(
                $privateId,
                ['status' => 'failed', 'limit' => 100]
            ),
        ];

        foreach ($calls as $call) {
            try {
                $call();
                self::fail('Expected the SMS evidence release hold.');
            } catch (ServerError $error) {
                self::assertSame(503, $error->status);
                self::assertSame(
                    SmsResource::EVIDENCE_READ_RELEASE_HELD_CODE,
                    $error->getErrorCode()
                );
                self::assertStringNotContainsString($privateId, $error->getMessage());
                self::assertStringNotContainsString('+15552345678', $error->getMessage());
                self::assertStringNotContainsString('private-api-token', $error->getMessage());
                self::assertStringNotContainsString('/api/v1/', $error->getMessage());
            }
        }
    }

    public function testConsentGrantFailsLocallyWithoutProofOrNetworkLeak(): void
    {
        $client = new Client('private-api-token', 'http://127.0.0.1:1', 1);
        $privateProof = 'private proof +15552345678';

        try {
            $client->sms->recordConsent([
                'phone_e164' => '+14155550123',
                'action' => 'granted',
                'source' => 'manual',
                'proof_text' => $privateProof,
            ]);
            self::fail('Expected provider resubscribe authority hold.');
        } catch (PostwaveError $error) {
            self::assertSame(409, $error->status);
            self::assertSame(
                'carrier_resubscribe_authority_required',
                $error->getErrorCode()
            );
            self::assertStringNotContainsString($privateProof, $error->getMessage());
            self::assertStringNotContainsString('+15552345678', $error->getMessage());
            self::assertStringNotContainsString('private-api-token', $error->getMessage());
            self::assertStringNotContainsString('/api/v1/', $error->getMessage());
        }
    }

    public function testA2PAndDispatchMethodsFailLocallyWithoutNetwork(): void
    {
        $client = new Client('private-api-token', 'http://127.0.0.1:1', 1);
        $privateId = 'private/+15552345678/token';
        $calls = [
            [
                static fn () => $client->sms->submitBrandRegistration(
                    $privateId,
                    ['company_name' => 'Private company']
                ),
                SmsResource::A2P_REGISTRATION_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->submitCampaignRegistration(
                    $privateId,
                    ['description' => 'Private campaign']
                ),
                SmsResource::A2P_REGISTRATION_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->pollA2PRegistration($privateId),
                SmsResource::A2P_REGISTRATION_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->createCampaign([
                    'name' => 'Private scheduled campaign',
                    'body' => 'Private body',
                    'status' => 'scheduled',
                ]),
                SmsResource::CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->sendCampaign($privateId, ['limit' => 1]),
                SmsResource::CAMPAIGN_DISPATCH_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->scheduleCampaign(
                    $privateId,
                    '2026-08-23T12:00:00Z'
                ),
                SmsResource::CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->resumeCampaign($privateId),
                SmsResource::CAMPAIGN_RESUME_RELEASE_HELD_CODE,
            ],
            [
                static fn () => $client->sms->sendTest([
                    'to' => '+15552345678',
                    'body' => 'Private body',
                ]),
                SmsResource::TEST_DISPATCH_RELEASE_HELD_CODE,
            ],
        ];

        foreach ($calls as [$call, $expectedCode]) {
            try {
                $call();
                self::fail('Expected the SMS operation release hold.');
            } catch (ServerError $error) {
                self::assertSame(503, $error->status);
                self::assertSame($expectedCode, $error->getErrorCode());
                self::assertStringNotContainsString($privateId, $error->getMessage());
                self::assertStringNotContainsString('+15552345678', $error->getMessage());
                self::assertStringNotContainsString('Private', $error->getMessage());
                self::assertStringNotContainsString('private-api-token', $error->getMessage());
                self::assertStringNotContainsString('/api/v1/', $error->getMessage());
            }
        }
    }

    public function testSenderRegistrationSelfAttestationFailsLocallyWithoutNetwork(): void
    {
        $client = new Client('private-api-token', 'http://127.0.0.1:1', 1);
        $unsafeInputs = [
            ['brand_registration_sid' => 'BN_PRIVATE'],
            ['campaign_registration_sid' => 'QE_PRIVATE'],
            ['registration_status' => 'approved'],
        ];

        foreach ($unsafeInputs as $input) {
            try {
                $client->sms->upsertSender($input);
                self::fail('Expected the sender registration evidence authority guard.');
            } catch (PostwaveError $error) {
                self::assertSame(409, $error->status);
                self::assertSame(
                    SmsResource::REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE,
                    $error->getErrorCode()
                );
                self::assertStringNotContainsString('PRIVATE', $error->getMessage());
                self::assertStringNotContainsString('private-api-token', $error->getMessage());
                self::assertStringNotContainsString('/api/v1/', $error->getMessage());
            }
        }
    }
}
