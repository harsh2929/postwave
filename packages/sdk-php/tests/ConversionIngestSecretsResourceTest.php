<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\AmbiguousConversionIngestSecretIssueError;
use Moosewave\Resources\ConversionIngestSecretsContract;

final class ConversionIngestSecretsResourceTest extends TestCase
{
    private const KEY_A = '0123456789abcdef0123456789abcdef';
    private const KEY_B = 'abcdef0123456789abcdef0123456789';
    private const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    private const CREATED = '2026-08-30T12:00:00.123Z';
    private const UPDATED = '2026-08-30T12:00:01Z';

    protected function setUp(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testListsOneBoundedClosedMetadataPage(): void
    {
        $failed = self::metadata(self::KEY_B, 'failed');
        $failed['label'] = 'retired';
        $failed['revoked_at'] = '2026-08-30T13:00:00+00:00';
        $failed['identity_projection_error_code'] = 'projection_failed';
        $server = LoopbackJsonServer::start([['body' => [
            'items' => [self::metadata(self::KEY_A, 'ready'), $failed],
            'next_cursor' => 'next-page',
        ]]]);
        $client = new Client('pw_admin', "http://127.0.0.1:$server->port");

        $page = $client->conversionIngestSecrets->list(17, 'page-token');
        $requests = $server->requests();

        $this->assertCount(1, $requests);
        $this->assertSame('GET', $requests[0]['method']);
        $this->assertSame(
            '/api/v1/conversions/ingest-secrets?limit=17&cursor=page-token',
            $requests[0]['target']
        );
        $this->assertSame('', $requests[0]['body']);
        $this->assertSame('next-page', $page['next_cursor']);
        $this->assertSame('projection_failed', $page['items'][1]['identity_projection_error_code']);
        $this->assertArrayNotHasKey('secret', $page['items'][0]);
    }

    public function testIssueIsExact201OneAttemptAndStripsEveryIdempotencyHeader(): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 201,
            'body' => self::issued(),
        ]]);
        $client = new Client(
            'pw_admin',
            "http://127.0.0.1:$server->port",
            30,
            ['Idempotency-Key' => 'client-default-must-not-leak']
        );

        $issued = $client->conversionIngestSecrets->issue('Orders 🔐');
        $requests = $server->requests();

        $this->assertCount(1, $requests);
        $this->assertSame('POST', $requests[0]['method']);
        $this->assertSame('/api/v1/conversions/ingest-secrets', $requests[0]['target']);
        $this->assertArrayNotHasKey('idempotency-key', $requests[0]['headers']);
        $this->assertSame(['label' => 'Orders 🔐'], json_decode($requests[0]['body'], true));
        $this->assertStringContainsString('🔐', $requests[0]['body']);
        $this->assertSame(self::SECRET, $issued['secret']['secret']);
        $this->assertSame('pending', $issued['secret']['identity_projection_status']);
        $this->assertSame(ConversionIngestSecretsContract::NOTICE, $issued['notice']);
    }

    public function testIssueNeverRetriesAndCarriesSafeAmbiguityRecovery(): void
    {
        $server = LoopbackJsonServer::start([[
            'status' => 503,
            'body' => ['error' => ['code' => 'internal', 'message' => 'failed']],
        ]]);
        $client = new Client('pw_admin', "http://127.0.0.1:$server->port");

        try {
            $client->conversionIngestSecrets->issue('orders');
            $this->fail('5xx reveal-once response must be ambiguous');
        } catch (AmbiguousConversionIngestSecretIssueError $error) {
            $this->assertStringContainsString('never retry issuance blindly', $error->getMessage());
            $this->assertSame(
                'ambiguous_conversion_ingest_secret_issue',
                $error->getErrorCode()
            );
        }
        $this->assertCount(1, $server->requests());
    }

    /**
     * @dataProvider malformedIssueProvider
     * @param array<string, mixed> $payload
     */
    public function testWrongSuccessOrMalformedRevealIsAmbiguous(int $status, array $payload): void
    {
        $server = LoopbackJsonServer::start([['status' => $status, 'body' => $payload]]);
        $client = new Client('pw_admin', "http://127.0.0.1:$server->port");

        try {
            $client->conversionIngestSecrets->issue('Orders 🔐');
            $this->fail('malformed reveal-once success must be ambiguous');
        } catch (AmbiguousConversionIngestSecretIssueError $error) {
            $this->assertStringNotContainsString(self::SECRET, $error->getMessage());
            $this->addToAssertionCount(1);
        } finally {
            $this->assertCount(1, $server->requests());
        }
    }

    /** @return iterable<string, array{int, array<string, mixed>}> */
    public static function malformedIssueProvider(): iterable
    {
        yield 'wrong status' => [200, self::issued()];
        $wrongSecret = self::issued();
        $wrongSecret['secret']['secret'] = 'wrong';
        yield 'wrong secret' => [201, $wrongSecret];
        $revoked = self::issued();
        $revoked['secret']['revoked_at'] = self::UPDATED;
        yield 'issued revoked' => [201, $revoked];
        $ready = self::issued();
        $ready['secret']['identity_projection_status'] = 'ready';
        yield 'not pending' => [201, $ready];
        $mismatch = self::issued();
        $mismatch['secret']['label'] = 'mismatched';
        yield 'mismatched label' => [201, $mismatch];
        $unknown = self::issued();
        $unknown['extra'] = true;
        yield 'unknown field' => [201, $unknown];
    }

    public function testClosedPagesAndLocalBoundsFailClosed(): void
    {
        $client = new Client('pw_admin', 'http://127.0.0.1:1');
        foreach ([0, 101] as $limit) {
            try {
                $client->conversionIngestSecrets->list($limit);
                $this->fail('invalid limit reached transport');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        foreach ([str_repeat('x', 513), "bad\u{0085}cursor"] as $cursor) {
            try {
                $client->conversionIngestSecrets->list(100, $cursor);
                $this->fail('invalid cursor reached transport');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        foreach ([' padded ', str_repeat('😀', 129), "bad\u{0085}label"] as $label) {
            try {
                $client->conversionIngestSecrets->issue($label);
                $this->fail('invalid label reached transport');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }

        $secretLeak = self::metadata(self::KEY_A, 'ready');
        $secretLeak['secret'] = self::SECRET;
        $nonFailedError = self::metadata(self::KEY_A, 'ready');
        $nonFailedError['identity_projection_error_code'] = null;
        foreach ([
            ['items' => [$secretLeak]],
            ['items' => [$nonFailedError]],
            ['items' => [self::metadata(self::KEY_A, 'ready'), self::metadata(self::KEY_A, 'ready')]],
            ['items' => [], 'unknown' => true],
            ['items' => null],
        ] as $payload) {
            try {
                ConversionIngestSecretsContract::decodePage($payload);
                $this->fail('hostile closed page was accepted');
            } catch (\UnexpectedValueException) {
                $this->addToAssertionCount(1);
            }
        }
        try {
            ConversionIngestSecretsContract::decodePage(
                ['items' => [], 'next_cursor' => 'same'],
                'same'
            );
            $this->fail('repeated cursor was accepted');
        } catch (\UnexpectedValueException) {
            $this->addToAssertionCount(1);
        }
    }

    public function testRevokeIsExactBodylessWriteWithStrictReceipt(): void
    {
        $server = LoopbackJsonServer::start([['body' => ['revoked' => true]]]);
        $client = new Client('pw_admin', "http://127.0.0.1:$server->port");

        $receipt = $client->conversionIngestSecrets->revoke(self::KEY_A);
        $requests = $server->requests();

        $this->assertSame(['revoked' => true], $receipt);
        $this->assertSame('POST', $requests[0]['method']);
        $this->assertSame(
            '/api/v1/conversions/ingest-secrets/' . self::KEY_A . '/revoke',
            $requests[0]['target']
        );
        $this->assertSame('', $requests[0]['body']);
        $this->assertArrayNotHasKey('idempotency-key', $requests[0]['headers']);

        $this->expectException(\InvalidArgumentException::class);
        $client->conversionIngestSecrets->revoke(strtoupper(self::KEY_A));
    }

    /** @return array<string, mixed> */
    private static function metadata(string $keyId, string $status): array
    {
        return [
            'key_id' => $keyId,
            'label' => 'Orders 🔐',
            'created_at' => self::CREATED,
            'identity_projection_status' => $status,
            'identity_projection_updated_at' => self::UPDATED,
        ];
    }

    /** @return array<string, mixed> */
    private static function issued(): array
    {
        $secret = self::metadata(self::KEY_A, 'pending');
        $secret['secret'] = self::SECRET;
        return [
            'secret' => $secret,
            'notice' => ConversionIngestSecretsContract::NOTICE,
        ];
    }
}
