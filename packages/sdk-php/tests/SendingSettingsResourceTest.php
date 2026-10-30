<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\ConflictError;
use Moosewave\Errors\ParseError;
use Moosewave\Resources\SendingSettingsResource;

final class SendingSettingsResourceTest extends TestCase
{
    /** @var array<string, mixed> */
    private const INPUT = [
        'max_sends_per_hour' => 2_500,
        'quiet_hours_start' => '22:00',
        'quiet_hours_end' => '07:00',
        'quiet_hours_tz' => 'America/New_York',
        'quiet_hours_per_recipient' => true,
        'fallback_hour_utc' => null,
        'expected_updated_at' => '2026-08-30T08:00:00Z',
    ];

    /** @var array<string, mixed> */
    private const COMMITTED = [
        'tenant_id' => '11111111-1111-4111-8111-111111111111',
        'max_sends_per_hour' => 2_500,
        'quiet_hours_start' => '22:00',
        'quiet_hours_end' => '07:00',
        'quiet_hours_tz' => 'America/New_York',
        'quiet_hours_per_recipient' => true,
        'fallback_hour_utc' => null,
        'updated_at' => '2026-08-30T08:01:00Z',
    ];

    protected function setUp(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testPublishesCausalQuiescenceWaitForAbsenceReconciliation(): void
    {
        $this->assertSame(35, SendingSettingsResource::RECONCILIATION_WAIT_SECONDS);
    }

    public function testSetIsOneAttemptStripsDefaultIdempotencyAndRequiresCommitProof(): void
    {
        $server = LoopbackJsonServer::start([[
            'body' => self::COMMITTED,
            'headers' => [
                'X-Postwave-Sending-Cap-Outcome' => 'committed',
                'X-Request-ID' => 'req-settings',
            ],
        ]]);
        $client = new Client(
            'pw_settings',
            "http://127.0.0.1:$server->port",
            30,
            ['Idempotency-Key' => 'client-default-must-not-leak']
        );

        $this->assertSame(self::COMMITTED, $client->sendingSettings->set(self::INPUT));
        $requests = $server->requests();
        $this->assertCount(1, $requests);
        $this->assertSame('PUT', $requests[0]['method']);
        $this->assertSame('/api/v1/settings/sending', $requests[0]['target']);
        $this->assertArrayNotHasKey('idempotency-key', $requests[0]['headers']);
        $this->assertSame(self::INPUT, json_decode($requests[0]['body'], true));
    }

    public function testSetDoesNotRetryAnOutcomeAmbiguous503(): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 503,
            'body' => [
                'error' => [
                    'code' => 'sending_cap_convergence_pending',
                    'message' => 'settings committed; cap convergence remains fenced',
                ],
            ],
            'headers' => [
                'X-Postwave-Sending-Cap-Outcome' => 'committed-conservatively-fenced',
            ],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('an unproven 503 must not be reported as success');
        } catch (ParseError $error) {
            $this->assertSame(503, $error->status);
            $this->assertStringContainsString('reconcile canonical settings', $error->getMessage());
        }
        $this->assertCount(1, $server->requests());
    }

    public function testSetTurnsATransportFailureIntoExplicitReconciliation(): void
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        $this->assertIsResource($socket, "cannot reserve loopback port: $errstr ($errno)");
        $name = stream_socket_get_name($socket, false);
        $this->assertIsString($name);
        $port = (int) substr($name, (int) strrpos($name, ':') + 1);
        fclose($socket);

        $client = new Client('pw_settings', "http://127.0.0.1:$port", 1);
        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('a transport failure must require explicit reconciliation');
        } catch (ParseError $error) {
            $this->assertSame(0, $error->status);
            $this->assertStringContainsString('35 seconds', $error->getMessage());
        }
    }

    /** @dataProvider unprovenFailureOutcomeProvider */
    public function testSetHoldsAnUnproven409ForReconciliation(array $headers): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 409,
            'body' => [
                'error' => [
                    'code' => 'settings_conflict',
                    'message' => 'settings changed',
                ],
            ],
            'headers' => $headers,
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('an unproven 409 must require reconciliation');
        } catch (ParseError $error) {
            $this->assertSame(409, $error->status);
            $this->assertStringContainsString('reconcile canonical settings', $error->getMessage());
        }
        $this->assertCount(1, $server->requests());
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function unprovenFailureOutcomeProvider(): iterable
    {
        yield 'missing' => [[]];
        yield 'malformed' => [[
            'X-Postwave-Sending-Cap-Outcome' => 'probably-not-committed',
        ]];
        yield 'contradictory committed' => [[
            'X-Postwave-Sending-Cap-Outcome' => 'committed',
        ]];
        yield 'contradictory fenced' => [[
            'X-Postwave-Sending-Cap-Outcome' => 'committed-conservatively-fenced',
        ]];
        yield 'contradictory unknown' => [[
            'X-Postwave-Sending-Cap-Outcome' =>
                'commit-outcome-unknown-conservatively-fenced',
        ]];
    }

    public function testSetPreservesAnExactNotCommitted409(): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 409,
            'body' => [
                'error' => [
                    'code' => 'settings_conflict',
                    'message' => 'settings changed',
                ],
            ],
            'headers' => [
                'X-Postwave-Sending-Cap-Outcome' => 'not-committed',
            ],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('an exact not-committed 409 must remain a conflict');
        } catch (ConflictError $error) {
            $this->assertSame('settings_conflict', $error->getErrorCode());
        }
        $this->assertCount(1, $server->requests());
    }

    /** @dataProvider redirectOutcomeProvider */
    public function testSetHoldsARedirectWithoutFollowingIt(array $headers): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 302,
            'body' => [
                'error' => [
                    'code' => 'redirected',
                    'message' => 'proxy redirect',
                ],
            ],
            'headers' => $headers,
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('a redirect must require reconciliation even with a receipt');
        } catch (ParseError $error) {
            $this->assertSame(302, $error->status);
            $this->assertStringContainsString('reconcile canonical settings', $error->getMessage());
        }
        $this->assertCount(1, $server->requests());
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function redirectOutcomeProvider(): iterable
    {
        yield 'headerless' => [[
            'Location' => '/api/v1/settings/sending-replayed',
        ]];
        yield 'contradictory not-committed' => [[
            'Location' => '/api/v1/settings/sending-replayed',
            'X-Postwave-Sending-Cap-Outcome' => 'not-committed',
        ]];
    }

    public function testSetProvesOmittedOwnedFieldsAgainstDefaultsAndPreservesFallback(): void
    {
        $input = ['expected_updated_at' => self::INPUT['expected_updated_at']];
        $defaultSettings = [
            'tenant_id' => self::COMMITTED['tenant_id'],
            'quiet_hours_per_recipient' => true,
            'fallback_hour_utc' => 17,
            'updated_at' => self::COMMITTED['updated_at'],
        ];
        $server = LoopbackJsonServer::start([[
            'body' => $defaultSettings,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->assertSame($defaultSettings, $client->sendingSettings->set($input));
        $this->assertCount(1, $server->requests());
    }

    public function testSetRejectsNonDefaultCommittedRowWhenOwnedFieldsWereOmitted(): void
    {
        $server = LoopbackJsonServer::start([[
            'body' => self::COMMITTED,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->expectException(ParseError::class);
        $client->sendingSettings->set([
            'expected_updated_at' => self::INPUT['expected_updated_at'],
        ]);
    }

    /** @dataProvider nonCanonicalQuietPolicyProvider */
    public function testSetRejectsACommittedRowEchoingNonCanonicalQuietPolicy(
        array $quietPolicy
    ): void {
        $input = [...self::INPUT, ...$quietPolicy];
        $candidate = [...self::COMMITTED, ...$quietPolicy];
        $server = LoopbackJsonServer::start([[
            'body' => $candidate,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->expectException(ParseError::class);
        $client->sendingSettings->set($input);
    }

    /** @return iterable<string, array{array<string, string>}> */
    public static function nonCanonicalQuietPolicyProvider(): iterable
    {
        yield 'partial tuple' => [[
            'quiet_hours_start' => '22:00',
            'quiet_hours_end' => '',
            'quiet_hours_tz' => '',
        ]];
        yield 'invalid time' => [[
            'quiet_hours_start' => '25:00',
            'quiet_hours_end' => '07:00',
            'quiet_hours_tz' => 'UTC',
        ]];
        yield 'equal endpoints' => [[
            'quiet_hours_start' => '07:00',
            'quiet_hours_end' => '07:00',
            'quiet_hours_tz' => 'UTC',
        ]];
        yield 'unknown timezone' => [[
            'quiet_hours_start' => '22:00',
            'quiet_hours_end' => '07:00',
            'quiet_hours_tz' => 'Mars/Olympus_Mons',
        ]];
    }

    public function testSetAcceptsAPortableIanaBackwardLink(): void
    {
        $input = [...self::INPUT, 'quiet_hours_tz' => 'Etc/UTC'];
        $candidate = [...self::COMMITTED, 'quiet_hours_tz' => 'Etc/UTC'];
        $server = LoopbackJsonServer::start([[
            'body' => $candidate,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->assertSame($candidate, $client->sendingSettings->set($input));
        $this->assertCount(1, $server->requests());
    }

    /**
     * @dataProvider invalidCommittedResponseProvider
     * @param array<string, mixed> $body
     * @param array<string, string> $headers
     */
    public function testSetRejectsUnprovenOrMismatchedSuccess(
        array $body,
        array $headers
    ): void {
        $server = LoopbackJsonServer::start([[
            'body' => $body,
            'headers' => $headers,
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        try {
            $client->sendingSettings->set(self::INPUT);
            $this->fail('invalid committed response must fail closed');
        } catch (ParseError $error) {
            $this->assertStringContainsString(
                'reconcile canonical settings',
                $error->getMessage()
            );
        }
        $this->assertCount(1, $server->requests());
    }

    /** @return iterable<string, array{array<string, mixed>, array<string, string>}> */
    public static function invalidCommittedResponseProvider(): iterable
    {
        yield 'missing proof' => [self::COMMITTED, []];
        yield 'mismatched policy' => [
            [...self::COMMITTED, 'max_sends_per_hour' => 9_999],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'invalid tenant UUID' => [
            [...self::COMMITTED, 'tenant_id' => 'tenant-1'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'unknown top-level property' => [
            [...self::COMMITTED, 'surprise' => true],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'invalid IP projection' => [
            [...self::COMMITTED, 'ip_pool' => ['name' => '', 'dedicated' => true]],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'unknown IP projection property' => [
            [
                ...self::COMMITTED,
                'ip_pool' => [
                    'name' => 'shared',
                    'dedicated' => false,
                    'surprise' => true,
                ],
            ],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'invalid user attribution' => [
            [...self::COMMITTED, 'updated_by_user_id' => 'user-1'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'mismatched explicit fallback' => [
            [...self::COMMITTED, 'fallback_hour_utc' => 17],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'zero revision' => [
            [...self::COMMITTED, 'updated_at' => '0001-01-01T00:00:00Z'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'fractional zero revision' => [
            [...self::COMMITTED, 'updated_at' => '0001-01-01T00:00:00.0Z'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'normalized invalid calendar revision' => [
            [...self::COMMITTED, 'updated_at' => '2026-02-30T08:01:00Z'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'offset beyond positive 14:00' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T08:01:00+14:01'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'offset beyond negative 14:00' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T08:01:00-23:59'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'invalid positive offset minutes' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T08:01:00+12:99'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'invalid negative offset minutes' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T08:01:00-13:60'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'unchanged baseline revision' => [
            [...self::COMMITTED, 'updated_at' => self::INPUT['expected_updated_at']],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'older revision' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T07:59:59.999999999Z'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
        yield 'equal instant in another offset' => [
            [...self::COMMITTED, 'updated_at' => '2026-08-30T09:00:00+01:00'],
            ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ];
    }

    public function testSetPreservesNanosecondsWhenProvingRevisionOrder(): void
    {
        $input = [
            ...self::INPUT,
            'expected_updated_at' => '2026-08-30T08:00:00.000000001Z',
        ];
        $committed = [
            ...self::COMMITTED,
            'updated_at' => '2026-08-30T08:00:00.000000002Z',
        ];
        $server = LoopbackJsonServer::start([[
            'body' => $committed,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->assertSame($committed, $client->sendingSettings->set($input));
        $this->assertCount(1, $server->requests());
    }

    /** @dataProvider initialRevisionProvider */
    public function testSetAcceptsAFreshRevisionWithoutAnExistingRevision(array $input): void
    {
        $server = LoopbackJsonServer::start([[
            'body' => self::COMMITTED,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->assertSame(self::COMMITTED, $client->sendingSettings->set($input));
        $this->assertCount(1, $server->requests());
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function initialRevisionProvider(): iterable
    {
        yield 'empty first-write assertion' => [[
            ...self::INPUT,
            'expected_updated_at' => '',
        ]];
        $legacy = self::INPUT;
        unset($legacy['expected_updated_at']);
        yield 'omitted legacy precondition' => [$legacy];
    }

    public function testWrongSuccessfulStatusIsNotAccepted(): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 204,
            'body' => self::COMMITTED,
            'headers' => ['X-Postwave-Sending-Cap-Outcome' => 'committed'],
        ]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->expectException(ParseError::class);
        $client->sendingSettings->set(self::INPUT);
    }

    public function testStatusReadsCanonicalCoordinationEndpoint(): void
    {
        $status = [
            'tenant_id' => self::COMMITTED['tenant_id'],
            'quiet_hours_per_recipient' => true,
            'counter_authoritative' => false,
            'counter_source' => 'unavailable',
            'counter_scope' => 'unavailable',
            'cap_coordination_state' => 'ready',
            'cap_coordination_ready' => true,
            'cap_coordination_matches_settings' => true,
        ];
        $server = LoopbackJsonServer::start([['body' => $status]]);
        $client = new Client('pw_settings', "http://127.0.0.1:$server->port");

        $this->assertSame($status, $client->sendingSettings->status());
        $requests = $server->requests();
        $this->assertCount(1, $requests);
        $this->assertSame('GET', $requests[0]['method']);
        $this->assertSame('/api/v1/settings/sending/status', $requests[0]['target']);
    }
}
