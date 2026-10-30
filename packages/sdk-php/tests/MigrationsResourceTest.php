<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;

final class MigrationsResourceTest extends TestCase
{
    /**
     * @param array<string, mixed> $response
     * @return array{0: int, 1: string}
     */
    private function serveOnce(array $response): array
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }

        $captureFile = tempnam(sys_get_temp_dir(), 'postwave_migration_req_');
        if ($captureFile === false) {
            $this->markTestSkipped('cannot create temp capture file');
        }

        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if ($server === false) {
            $this->markTestSkipped("cannot bind loopback socket: $errstr ($errno)");
        }
        $name = stream_socket_get_name($server, false);
        $port = (int) substr($name, (int) strrpos($name, ':') + 1);

        $pid = pcntl_fork();
        if ($pid === -1) {
            $this->markTestSkipped('pcntl_fork unavailable');
        }
        if ($pid === 0) {
            $conn = stream_socket_accept($server, 5);
            if ($conn !== false) {
                stream_set_timeout($conn, 1);
                $raw = '';
                $headers = '';
                while (($line = fgets($conn)) !== false) {
                    $raw .= $line;
                    $headers .= $line;
                    if (rtrim($line, "\r\n") === '') {
                        break;
                    }
                }
                $body = '';
                if (preg_match('/Content-Length:\s*(\d+)/i', $headers, $m) === 1) {
                    $remaining = (int) $m[1];
                    while ($remaining > 0 && !feof($conn)) {
                        $chunk = fread($conn, $remaining);
                        if ($chunk === false || $chunk === '') {
                            break;
                        }
                        $body .= $chunk;
                        $remaining -= strlen($chunk);
                    }
                }
                $raw .= $body;
                file_put_contents($captureFile, $raw);

                $json = json_encode($response);
                if ($json === false) {
                    $json = '{}';
                }
                fwrite(
                    $conn,
                    "HTTP/1.1 200 OK\r\n"
                    . "Content-Type: application/json\r\n"
                    . 'Content-Length: ' . strlen($json) . "\r\n"
                    . "Connection: close\r\n\r\n"
                    . $json
                );
                fclose($conn);
            }
            fclose($server);
            exit(0);
        }

        fclose($server);
        return [$port, $captureFile];
    }

    /**
     * @return array{method: string, path: string, body: mixed}
     */
    private function capturedRequest(string $captureFile): array
    {
        $raw = file_get_contents($captureFile);
        @unlink($captureFile);
        $this->assertIsString($raw);

        $parts = explode("\r\n\r\n", $raw, 2);
        $requestLine = strtok($parts[0], "\r\n");
        $this->assertIsString($requestLine);
        $pieces = explode(' ', $requestLine);

        return [
            'method' => $pieces[0] ?? '',
            'path' => $pieces[1] ?? '',
            'body' => isset($parts[1]) && $parts[1] !== '' ? json_decode($parts[1], true) : null,
        ];
    }

    /**
     * @param array<string, mixed> $response
     * @param callable(Client): mixed $exercise
     * @param array{method: string, path: string, body: mixed} $expected
     */
    private function assertSingleMigrationRequest(array $response, callable $exercise, array $expected): void
    {
        [$port, $capture] = $this->serveOnce($response);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $exercise($client);
        pcntl_wait($status);

        $this->assertSame($expected, $this->capturedRequest($capture));
    }

    public function testShadowMonitorStartUsesSourceScopedPath(): void
    {
        $this->assertSingleMigrationRequest(
            ['monitor' => ['enabled' => true], 'history' => []],
            static fn (Client $client) => $client->migrations->startShadowMonitor('activecampaign', 'job/a', 900),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/sources/activecampaign/shadow-monitor',
                'body' => ['job_id' => 'job/a', 'interval_seconds' => 900],
            ]
        );
    }

    public function testMailchimpDryRunForwardsExplicitAudienceScope(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a'],
            static fn (Client $client) => $client->migrations->dryRun('mailchimp', 'job/a', ['aud_a', 'aud_b']),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/mailchimp/dry-run',
                'body' => [
                    'job_id' => 'job/a',
                    'selected_audience_ids' => ['aud_a', 'aud_b'],
                ],
            ]
        );
    }

    public function testMailchimpDiscoverySupportsUnscopedAndExplicitAudienceScope(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a', 'source' => 'mailchimp', 'audiences' => []],
            static fn (Client $client) => $client->migrations->discover('mailchimp', 'job/a'),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/mailchimp/discover',
                'body' => ['job_id' => 'job/a'],
            ]
        );

        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a', 'source' => 'mailchimp', 'audiences' => []],
            static fn (Client $client) => $client->migrations->discover('mailchimp', 'job/a', [' aud_a ']),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/mailchimp/discover',
                'body' => [
                    'job_id' => 'job/a',
                    'selected_audience_ids' => ['aud_a'],
                ],
            ]
        );
    }

    public function testKlaviyoDiscoveryPreservesExtendedInventoryCounts(): void
    {
        $expected = [
            'job_id' => 'job/klaviyo',
            'source' => 'klaviyo',
            'subscribers_count' => 120,
            'profiles_without_email_count' => 3,
            'source_archive_count' => 12,
            'sms_campaigns_count' => 2,
            'push_campaigns_count' => 1,
        ];
        [$port, $capture] = $this->serveOnce($expected);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");

        $discovery = $client->migrations->discover('klaviyo', 'job/klaviyo');
        pcntl_wait($status);

        $this->assertSame($expected, $discovery);
        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/klaviyo/discover',
            'body' => ['job_id' => 'job/klaviyo'],
        ], $this->capturedRequest($capture));
    }

    public function testCustomerIODiscoveryPreservesObjectTypeMetadataCount(): void
    {
        $expected = [
            'job_id' => 'job/customerio',
            'source' => 'customerio',
            'subscribers_count' => 7,
            'custom_objects_count' => 4,
            'subscription_channels_count' => 3,
        ];
        [$port, $capture] = $this->serveOnce($expected);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");

        $discovery = $client->migrations->discover('customerio', 'job/customerio');
        pcntl_wait($status);

        $this->assertSame($expected, $discovery);
        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/customerio/discover',
            'body' => ['job_id' => 'job/customerio'],
        ], $this->capturedRequest($capture));
    }

    public function testHubSpotDiscoveryPreservesAdditionalEmailIdentityCount(): void
    {
        $expected = [
            'job_id' => 'job/hubspot',
            'source' => 'hubspot',
            'subscribers_count' => 7,
            'profiles_without_email_count' => 2,
            'additional_email_identities_count' => 3,
        ];
        [$port, $capture] = $this->serveOnce($expected);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");

        $discovery = $client->migrations->discover('hubspot', 'job/hubspot');
        pcntl_wait($status);

        $this->assertSame($expected, $discovery);
        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/hubspot/discover',
            'body' => ['job_id' => 'job/hubspot'],
        ], $this->capturedRequest($capture));
    }

    public function testCustomerIOVerificationPreservesSubscriptionChannelArchiveCount(): void
    {
        $expected = [
            'source_archive_imported' => 42,
            'source_archive_by_resource' => [
                'customerio_subscription_channel' => 3,
            ],
        ];
        [$port, $capture] = $this->serveOnce($expected);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");

        $verification = $client->migrations->verification('job/customerio');
        pcntl_wait($status);

        $this->assertSame($expected, $verification);
        $this->assertSame([
            'method' => 'GET',
            'path' => '/api/v1/migrations/job%2Fcustomerio/verification',
            'body' => null,
        ], $this->capturedRequest($capture));
    }

    public function testKlaviyoCredentialsSupportCallerManagedBearerTokens(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/klaviyo', 'account_id' => 'account_primary'],
            static fn (Client $client) => $client->migrations->credentials('klaviyo', [
                'access_token' => 'klaviyo-oauth-token',
                'refresh_token' => 'klaviyo-refresh-token',
                'account_id' => 'account_primary',
            ]),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/klaviyo/credentials',
                'body' => [
                    'access_token' => 'klaviyo-oauth-token',
                    'refresh_token' => 'klaviyo-refresh-token',
                    'account_id' => 'account_primary',
                ],
            ]
        );
    }

    public function testCustomerIOCredentialsPreserveWorkspaceAndRegion(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/customerio', 'account_id' => '9001'],
            static fn (Client $client) => $client->migrations->credentials('customerio', [
                'api_key' => 'cio_app_key',
                'account_id' => '9001',
                'extra' => ['region' => 'eu'],
            ]),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/customerio/credentials',
                'body' => [
                    'api_key' => 'cio_app_key',
                    'account_id' => '9001',
                    'extra' => ['region' => 'eu'],
                ],
            ]
        );
    }

    public function testMailchimpCommitForwardsExplicitAudienceScope(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a'],
            static fn (Client $client) => $client->migrations->commit('mailchimp', 'job/a', [' aud_a ', 'aud_b']),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/mailchimp/commit',
                'body' => [
                    'job_id' => 'job/a',
                    'selected_audience_ids' => ['aud_a', 'aud_b'],
                ],
            ]
        );
    }

    public function testMailchimpDryRunRejectsMissingAudienceScopeBeforeRequest(): void
    {
        $client = new Client('pw_test_migrations', 'http://127.0.0.1:1');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('selected audience ID');
        $client->migrations->dryRun('mailchimp', 'job/a');
    }

    public function testMailchimpCommitRejectsMissingAudienceScopeBeforeRequest(): void
    {
        $client = new Client('pw_test_migrations', 'http://127.0.0.1:1');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('selected audience ID');
        $client->migrations->commit('mailchimp', 'job/a');
    }

    public function testMailchimpAudienceScopeRejectsBlankIdsBeforeRequest(): void
    {
        $client = new Client('pw_test_migrations', 'http://127.0.0.1:1');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('audience IDs must not be empty');
        $client->migrations->dryRun('mailchimp', 'job/a', ['aud_a', '  ']);
    }

    public function testMailchimpOAuthReconnectKeepsTheExistingJobId(): void
    {
        $this->assertSingleMigrationRequest(
            [
                'authorize_url' => 'https://login.mailchimp.com/oauth2/authorize',
                'state' => 'csrf',
            ],
            static fn (Client $client) => $client->migrations->start('mailchimp', ' job/a '),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/mailchimp/oauth/start?job_id=job%2Fa',
                'body' => null,
            ]
        );

        $client = new Client('pw_test_migrations', 'http://127.0.0.1:1');
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('job ID is required for OAuth reconnect');
        $client->migrations->start('mailchimp', ' ');
    }

    public function testMailchimpOAuthCallbackEncodesCodeAndState(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a'],
            static fn (Client $client) => $client->migrations->callback('mailchimp', 'code/a+b', 'state/a+b'),
            [
                'method' => 'GET',
                'path' => '/api/v1/migrations/mailchimp/oauth/callback?code=code%2Fa%2Bb&state=state%2Fa%2Bb',
                'body' => null,
            ]
        );
    }

    public function testRollbackReturnsAcceptedJobAndState(): void
    {
        [$port, $capture] = $this->serveOnce(['job_id' => 'job/a', 'state' => 'running']);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");

        $accepted = $client->migrations->rollback('job/a');
        pcntl_wait($status);

        $this->assertSame(['job_id' => 'job/a', 'state' => 'running'], $accepted);
        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/job%2Fa/rollback',
            'body' => null,
        ], $this->capturedRequest($capture));
    }

    public function testRollbackStatusUsesEncodedJobPath(): void
    {
        $this->assertSingleMigrationRequest(
            ['state' => 'running', 'subscribers_deleted' => 1, 'subscribers_total' => 3],
            static fn (Client $client) => $client->migrations->rollbackStatus(' job/a '),
            [
                'method' => 'GET',
                'path' => '/api/v1/migrations/job%2Fa/rollback-status',
                'body' => null,
            ]
        );
    }

    public function testSourceEventStopOmitsCleanupAuthorizationByDefault(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a', 'enabled' => false],
            static fn (Client $client) => $client->migrations->stopSourceEvents('job/a'),
            [
                'method' => 'DELETE',
                'path' => '/api/v1/migrations/job%2Fa/source-events',
                'body' => null,
            ]
        );
    }

    public function testActiveCampaignSourceEventAndCutoverMethodsRouteToExpectedPaths(): void
    {
        [$port, $capture] = $this->serveOnce([
            'monitor' => [
                'job_id' => 'job/a',
                'source' => 'activecampaign',
                'enabled' => true,
                'interval_seconds' => 900,
            ],
            'events' => [],
        ]);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $out = $client->migrations->startSourceEvents('activecampaign', 'job/a', 900);
        pcntl_wait($status);

        $this->assertTrue($out['monitor']['enabled']);
        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/sources/activecampaign/source-events',
            'body' => ['job_id' => 'job/a', 'interval_seconds' => 900],
        ], $this->capturedRequest($capture));

        [$port, $capture] = $this->serveOnce([
            'id' => 'event/a',
            'job_id' => 'job/a',
            'source' => 'activecampaign',
            'source_event_id' => '[redacted-activecampaign-source-event-id]',
            'resource_type' => 'activecampaign_non_email_contact',
            'action' => 'manual_review',
            'applied' => false,
            'review_status' => 'reviewed',
        ]);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $out = $client->migrations->updateSourceEventReview('job/a', 'event/a', [
            'status' => 'reviewed',
            'detail' => 'Phone-only contact reconciled.',
            'evidence' => ['cutover-ticket-42'],
        ]);
        pcntl_wait($status);

        $this->assertFalse($out['applied']);
        $this->assertSame('reviewed', $out['review_status']);
        $this->assertSame([
            'method' => 'PATCH',
            'path' => '/api/v1/migrations/job%2Fa/source-events/event%2Fa/review',
            'body' => [
                'status' => 'reviewed',
                'detail' => 'Phone-only contact reconciled.',
                'evidence' => ['cutover-ticket-42'],
            ],
        ], $this->capturedRequest($capture));

        [$port, $capture] = $this->serveOnce([
            'job_id' => 'job/a',
            'source' => 'activecampaign',
            'status' => 'pass',
            'blockers' => 0,
            'warnings' => 0,
            'items' => [],
        ]);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $client->migrations->recordCutoverEvidence('job/a', [
            'key' => 'activecampaign_automation_rebuild_review',
            'status' => 'pass',
            'detail' => 'Operator reviewed rebuild evidence.',
        ]);
        pcntl_wait($status);

        $this->assertSame([
            'method' => 'PATCH',
            'path' => '/api/v1/migrations/job%2Fa/cutover-evidence',
            'body' => [
                'key' => 'activecampaign_automation_rebuild_review',
                'status' => 'pass',
                'detail' => 'Operator reviewed rebuild evidence.',
            ],
        ], $this->capturedRequest($capture));
    }

    public function testHubSpotCredentialsRoutePrivateAppTokenToExpectedPath(): void
    {
        [$port, $capture] = $this->serveOnce([
            'job_id' => 'job/a',
            'account_id' => '12345',
        ]);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $client->migrations->credentials('hubspot', [
            'api_key' => 'pat-secret',
            'account_id' => '12345',
            'extra' => ['hub_id' => '12345'],
        ]);
        pcntl_wait($status);

        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/hubspot/credentials',
            'body' => [
                'api_key' => 'pat-secret',
                'account_id' => '12345',
                'extra' => ['hub_id' => '12345'],
            ],
        ], $this->capturedRequest($capture));
    }

    public function testBeehiivCredentialsBindExplicitPublication(): void
    {
        [$port, $capture] = $this->serveOnce([
            'job_id' => 'job/a',
            'account_id' => 'pub_primary',
        ]);
        $client = new Client('pw_test_migrations', "http://127.0.0.1:$port");
        $client->migrations->credentials('beehiiv', [
            'api_key' => 'beehiiv-secret',
            'account_id' => 'pub_primary',
            'extra' => ['publication_id' => 'pub_primary'],
        ]);
        pcntl_wait($status);

        $this->assertSame([
            'method' => 'POST',
            'path' => '/api/v1/migrations/beehiiv/credentials',
            'body' => [
                'api_key' => 'beehiiv-secret',
                'account_id' => 'pub_primary',
                'extra' => ['publication_id' => 'pub_primary'],
            ],
        ], $this->capturedRequest($capture));
    }

	public function testKlaviyoCredentialAndCutoverLifecycleRoutesToExpectedPaths(): void
	{
		$this->assertSingleMigrationRequest(
			['job_id' => 'job/a', 'account_id' => 'account_primary'],
			static fn (Client $client) => $client->migrations->credentials('klaviyo', [
				'api_key' => 'klaviyo-private-key',
				'account_id' => 'account_primary',
			]),
			[
				'method' => 'POST',
				'path' => '/api/v1/migrations/klaviyo/credentials',
				'body' => [
					'api_key' => 'klaviyo-private-key',
					'account_id' => 'account_primary',
				],
			]
		);

		$this->assertSingleMigrationRequest(
			['id' => 'job/a', 'source' => 'klaviyo', 'status' => 'completed'],
			static fn (Client $client) => $client->migrations->refreshSourceSession('job/a', [
				'access_token' => 'klaviyo-oauth-token',
				'refresh_token' => 'klaviyo-refresh-token',
				'account_id' => 'account_primary',
			]),
			[
				'method' => 'POST',
				'path' => '/api/v1/migrations/job%2Fa/source-session',
				'body' => [
					'access_token' => 'klaviyo-oauth-token',
					'refresh_token' => 'klaviyo-refresh-token',
					'account_id' => 'account_primary',
				],
			]
		);

		$this->assertSingleMigrationRequest(
			['job_id' => 'job/a', 'mode' => 'delta_import'],
			static fn (Client $client) => $client->migrations->deltaImport('klaviyo', 'job/a'),
			[
				'method' => 'POST',
				'path' => '/api/v1/migrations/klaviyo/delta-import',
				'body' => ['job_id' => 'job/a'],
			]
		);

		$this->assertSingleMigrationRequest(
			[
				'job_id' => 'job/a',
				'source' => 'klaviyo',
				'current_discovery' => [],
				'needs_delta_import' => false,
				'recommended_action' => 'ready_for_cutover_review',
				'deltas' => [],
			],
			static fn (Client $client) => $client->migrations->shadowCheck('klaviyo', 'job/a'),
			[
				'method' => 'POST',
				'path' => '/api/v1/migrations/klaviyo/shadow-check',
				'body' => ['job_id' => 'job/a'],
			]
		);

		$this->assertSingleMigrationRequest(
			['monitor' => ['job_id' => 'job/a', 'source' => 'klaviyo', 'enabled' => true], 'events' => []],
			static fn (Client $client) => $client->migrations->startSourceEvents('klaviyo', 'job/a', 900),
			[
				'method' => 'POST',
				'path' => '/api/v1/migrations/sources/klaviyo/source-events',
				'body' => ['job_id' => 'job/a', 'interval_seconds' => 900],
			]
		);

		$this->assertSingleMigrationRequest(
			['job_id' => 'job/a', 'source' => 'klaviyo', 'status' => 'blocker', 'items' => []],
			static fn (Client $client) => $client->migrations->recordCutoverEvidence('job/a', [
				'key' => 'klaviyo_audience_snapshot_review',
				'status' => 'pass',
				'detail' => 'Final audience snapshots and dynamic-rule rebuilds were reviewed.',
				'evidence' => ['cutover-ticket-42'],
			]),
			[
				'method' => 'PATCH',
				'path' => '/api/v1/migrations/job%2Fa/cutover-evidence',
				'body' => [
					'key' => 'klaviyo_audience_snapshot_review',
					'status' => 'pass',
					'detail' => 'Final audience snapshots and dynamic-rule rebuilds were reviewed.',
					'evidence' => ['cutover-ticket-42'],
				],
			]
		);
	}

    public function testHubSpotPilotBridgeMethodsRouteToExpectedPaths(): void
    {
        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a', 'mode' => 'delta_import'],
            static fn (Client $client) => $client->migrations->deltaImport('hubspot', 'job/a'),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/hubspot/delta-import',
                'body' => ['job_id' => 'job/a'],
            ]
        );

        $this->assertSingleMigrationRequest(
            [
                'job_id' => 'job/a',
                'source' => 'hubspot',
                'current_discovery' => [],
                'needs_delta_import' => false,
                'recommended_action' => 'ready_for_cutover_review',
                'deltas' => [],
            ],
            static fn (Client $client) => $client->migrations->shadowCheck('hubspot', 'job/a'),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/hubspot/shadow-check',
                'body' => ['job_id' => 'job/a'],
            ]
        );

        $this->assertSingleMigrationRequest(
            [
                'monitor' => [
                    'job_id' => 'job/a',
                    'source' => 'hubspot',
                    'enabled' => true,
                    'interval_seconds' => 900,
                ],
                'events' => [],
            ],
            static fn (Client $client) => $client->migrations->startSourceEvents('hubspot', 'job/a', 900),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/sources/hubspot/source-events',
                'body' => ['job_id' => 'job/a', 'interval_seconds' => 900],
            ]
        );

        $this->assertSingleMigrationRequest(
            [
                'monitor' => [
                    'job_id' => 'job/a',
                    'source' => 'hubspot',
                    'enabled' => true,
                    'interval_seconds' => 900,
                ],
                'events' => [],
            ],
            static fn (Client $client) => $client->migrations->sourceEvents('job/a'),
            [
                'method' => 'GET',
                'path' => '/api/v1/migrations/job%2Fa/source-events',
                'body' => null,
            ]
        );

        $this->assertSingleMigrationRequest(
            ['job_id' => 'job/a', 'enabled' => false, 'source_session_cleared' => true],
            static fn (Client $client) => $client->migrations->stopSourceEvents('job/a', true),
            [
                'method' => 'DELETE',
                'path' => '/api/v1/migrations/job%2Fa/source-events?post_pilot_cleanup=1',
                'body' => null,
            ]
        );

        $this->assertSingleMigrationRequest(
            ['id' => 'job/a', 'source' => 'hubspot', 'status' => 'completed'],
            static fn (Client $client) => $client->migrations->refreshSourceSession('job/a', [
                'api_key' => 'pat-secret-rotated',
                'account_id' => '12345',
                'extra' => ['portal_id' => '12345'],
            ]),
            [
                'method' => 'POST',
                'path' => '/api/v1/migrations/job%2Fa/source-session',
                'body' => [
                    'api_key' => 'pat-secret-rotated',
                    'account_id' => '12345',
                    'extra' => ['portal_id' => '12345'],
                ],
            ]
        );

        $this->assertSingleMigrationRequest(
            [
                'job_id' => 'job/a',
                'source' => 'hubspot',
                'status' => 'pass',
                'blockers' => 0,
                'warnings' => 0,
                'items' => [],
            ],
            static fn (Client $client) => $client->migrations->pilotAcceptance('job/a'),
            [
                'method' => 'GET',
                'path' => '/api/v1/migrations/job%2Fa/pilot-acceptance',
                'body' => null,
            ]
        );

        $this->assertSingleMigrationRequest(
            [
                'job_id' => 'job/a',
                'source' => 'hubspot',
                'status' => 'pass',
                'total_resources' => 0,
                'items' => [],
            ],
            static fn (Client $client) => $client->migrations->rollbackRehearsal('job/a'),
            [
                'method' => 'GET',
                'path' => '/api/v1/migrations/job%2Fa/rollback-rehearsal',
                'body' => null,
            ]
        );
    }

    public function testSourceEventStatusAndStopMethodsAreExposed(): void
    {
        $client = new Client('pw_test_migrations');

        $this->assertTrue(method_exists($client->migrations, 'startSourceEvents'));
        $this->assertTrue(method_exists($client->migrations, 'sourceEvents'));
        $this->assertTrue(method_exists($client->migrations, 'stopSourceEvents'));
        $this->assertTrue(method_exists($client->migrations, 'updateSourceEventReview'));
        $this->assertTrue(method_exists($client->migrations, 'recordCutoverEvidence'));
    }
}
