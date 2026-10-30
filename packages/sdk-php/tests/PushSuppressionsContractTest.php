<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\PostwaveError;
use Moosewave\Resources\PushSuppressionsContract;
use Moosewave\Resources\PushSuppressionsResource;

final class PushSuppressionsContractTest extends TestCase
{
    private const TENANT = '00000000-0000-0000-0000-000000000001';
    private const OTHER_TENANT = '00000000-0000-0000-0000-000000000002';
    private const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    private const SECOND_ID = '99999999-9999-4999-8999-999999999999';

    /** @return array<string, mixed> */
    private static function row(array $overrides = []): array
    {
        return [
            'id' => self::ID,
            'tenant_id' => self::TENANT,
            'device_token_hash' => '0123456789abcdef',
            'platform' => 'fcm',
            'reason' => 'manual',
            'source' => 'dashboard',
            'created_at' => '2026-08-28T10:00:00Z',
            'updated_at' => '2026-08-28T10:00:01Z',
            'version' => 1,
            'reversible' => true,
            ...$overrides,
        ];
    }

    /** @return array<string, mixed> */
    private static function lockedRow(array $overrides = []): array
    {
        return self::row([
            'id' => self::SECOND_ID,
            'device_token_hash' => '1111222233334444',
            'reason' => 'unregistered',
            'source' => 'provider',
            'reversible' => false,
            'locked_reason' => 'provider_authority',
            ...$overrides,
        ]);
    }

    private static function assertContractRejects(callable $operation): void
    {
        try {
            $operation();
            self::fail('Expected malformed push suppression contract data to be rejected');
        } catch (PostwaveError $error) {
            self::assertSame(502, $error->status);
            self::assertSame('invalid_push_suppression_response', $error->getErrorCode());
            self::assertStringNotContainsString('device_token', $error->getMessage());
        }
    }

    public function testClientExposesDedicatedFiveOperationResource(): void
    {
        $client = new Client('pw_test_push_suppression_surface');
        $this->assertInstanceOf(PushSuppressionsResource::class, $client->pushSuppressions);

        $methods = array_map(
            static fn (\ReflectionMethod $method): string => $method->getName(),
            array_filter(
                (new \ReflectionClass(PushSuppressionsResource::class))->getMethods(\ReflectionMethod::IS_PUBLIC),
                static fn (\ReflectionMethod $method): bool =>
                    $method->getDeclaringClass()->getName() === PushSuppressionsResource::class
            )
        );
        sort($methods);
        $this->assertSame(['add', 'bulkImport', 'bulkRemove', 'list', 'remove'], $methods);
    }

    public function testPublicEnumsAreExactlyBounded(): void
    {
        $this->assertSame(['apns', 'fcm', 'web'], PushSuppressionsResource::PLATFORMS);
        $this->assertSame(
            ['manual', 'unregistered', 'expired', 'complaint', 'user_opt_out'],
            PushSuppressionsResource::REASONS
        );
        $this->assertSame(
            ['dashboard', 'provider', 'user', 'complaint', 'legacy'],
            PushSuppressionsResource::SOURCES
        );
        $this->assertSame(
            [
                'provider_authority',
                'user_opt_out_authority',
                'complaint_authority',
                'legacy_authority_requires_review',
            ],
            PushSuppressionsResource::LOCKED_REASONS
        );
    }

    public function testRoutesUseHashPrefixBodyOnlyTokensAndCasVersion(): void
    {
        $source = file_get_contents((new \ReflectionClass(PushSuppressionsResource::class))->getFileName());
        $this->assertSame(5, substr_count($source, "'/api/v1/push/suppressions"));
        $this->assertStringContainsString("'/api/v1/push/suppressions/bulk-import'", $source);
        $this->assertStringContainsString("'/api/v1/push/suppressions/bulk-remove'", $source);
        $this->assertStringContainsString("['expected_version' => \$expected['expected_version']]", $source);
        $this->assertStringContainsString("'hash_prefix'", file_get_contents(
            (new \ReflectionClass(PushSuppressionsContract::class))->getFileName()
        ));
        $this->assertStringNotContainsString('device_token_hash_prefix', $source);
        $this->assertDoesNotMatchRegularExpression('/push\/suppressions\?/', $source);
        foreach (['error_log', 'trigger_error', 'var_dump', 'print_r'] as $logger) {
            $this->assertStringNotContainsString($logger, $source);
        }
    }

    public function testListOptionsAreStrictAndUseWireHashPrefix(): void
    {
        $this->assertSame(
            [
                'limit' => 1,
                'platform' => 'fcm',
                'reason' => 'manual',
                'hash_prefix' => '01234567',
                'cursor' => 'eyJ2IjoxfQ',
            ],
            PushSuppressionsContract::listOptions([
                'platform' => 'fcm',
                'reason' => 'manual',
                'hash_prefix' => '01234567',
                'cursor' => 'eyJ2IjoxfQ',
                'limit' => 1,
            ])
        );
        $this->assertSame(['limit' => 50], PushSuppressionsContract::listOptions([]));

        foreach ([
            ['platform' => 'ios'],
            ['reason' => 'provider_bounce'],
            ['hash_prefix' => '0123456'],
            ['hash_prefix' => '0123456A'],
            ['cursor' => 'cursor.with.dot'],
            ['limit' => 0],
            ['limit' => 101],
            ['limit' => true],
            ['source' => 'dashboard'],
        ] as $invalid) {
            try {
                PushSuppressionsContract::listOptions($invalid);
                $this->fail('Expected invalid push suppression list options to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('Push suppression', $error->getMessage());
            }
        }
    }

    public function testEveryOperationRequiresCanonicalTenantBinding(): void
    {
        $this->assertSame(self::TENANT, PushSuppressionsContract::expectedTenant(self::TENANT));
        foreach (['', 'A0000000-0000-0000-0000-000000000001', 'tenant_1', self::TENANT . '0'] as $invalid) {
            try {
                PushSuppressionsContract::expectedTenant($invalid);
                $this->fail('Expected invalid tenant binding to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('canonical tenant UUID', $error->getMessage());
            }
        }

        foreach (['list', 'add', 'remove', 'bulkImport', 'bulkRemove'] as $method) {
            $parameters = (new \ReflectionMethod(PushSuppressionsResource::class, $method))->getParameters();
            $parameterNames = array_map(
                static fn (\ReflectionParameter $parameter): string => $parameter->getName(),
                $parameters
            );
            $this->assertContains(
                'expectedTenantId',
                $parameterNames,
                "$method must require exact tenant binding"
            );
        }
    }

    public function testAddValidationIsManualExactAndNeverLeaksRawTokenInErrors(): void
    {
        $token = 'secret-token-' . str_repeat('x', 24);
        $this->assertSame(
            ['device_token' => $token, 'platform' => 'fcm', 'reason' => 'manual'],
            PushSuppressionsContract::addInput([
                'device_token' => $token,
                'platform' => 'fcm',
                'reason' => 'manual',
            ])
        );

        $invalidInputs = [
            ['device_token' => $token, 'platform' => 'fcm'],
            ['device_token' => $token, 'platform' => 'fcm', 'reason' => 'complaint'],
            ['device_token' => $token, 'platform' => 'ios', 'reason' => 'manual'],
            ['device_token' => "$token ", 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => "secret\n" . str_repeat('x', 20), 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => str_repeat('x', 19), 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => str_repeat('x', 4097), 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => "\xFF" . str_repeat('x', 20), 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => $token, 'platform' => 'fcm', 'reason' => 'manual', 'log' => true],
        ];
        foreach ($invalidInputs as $input) {
            try {
                PushSuppressionsContract::addInput($input);
                $this->fail('Expected unsafe push suppression token input to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringNotContainsString($token, $error->getMessage());
            }
        }
    }

    public function testStrictRowDecoderReturnsOnlyFingerprintProjection(): void
    {
        $manual = PushSuppressionsContract::decodeRow(self::row(), self::TENANT);
        $locked = PushSuppressionsContract::decodeRow(self::lockedRow(), self::TENANT);
        $this->assertSame('0123456789abcdef', $manual['device_token_hash']);
        $this->assertArrayNotHasKey('device_token', $manual);
        $this->assertArrayNotHasKey('locked_reason', $manual);
        $this->assertSame('provider_authority', $locked['locked_reason']);
        $this->assertFalse($locked['reversible']);
    }

    /** @dataProvider invalidRows */
    public function testStrictRowDecoderRejectsTenantPrivacyAndAuthorityPoison(array $row): void
    {
        self::assertContractRejects(
            static fn (): array => PushSuppressionsContract::decodeRow($row, self::TENANT)
        );
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function invalidRows(): iterable
    {
        yield 'wrong tenant' => [[...self::row(), 'tenant_id' => self::OTHER_TENANT]];
        yield 'full digest' => [[...self::row(), 'device_token_hash' => str_repeat('a', 64)]];
        yield 'uppercase fingerprint' => [[...self::row(), 'device_token_hash' => '0123456789abcdeF']];
        yield 'private raw token' => [[...self::row(), 'device_token' => str_repeat('s', 30)]];
        yield 'private event id' => [[...self::row(), 'source_event_id' => 'evt_private']];
        yield 'invented source' => [[...self::lockedRow(), 'source' => 'provider_webhook']];
        yield 'invented lock' => [[...self::lockedRow(), 'locked_reason' => 'support_override']];
        yield 'manual locked' => [[...self::row(), 'locked_reason' => 'provider_authority']];
        yield 'provider reversible' => [[...self::lockedRow(), 'reversible' => true]];
        yield 'updated before created' => [[...self::row(), 'updated_at' => '2026-08-28T09:59:59Z']];
        yield 'offset timestamp' => [[...self::row(), 'created_at' => '2026-08-28T10:00:00+00:00']];
        yield 'invalid date' => [[...self::row(), 'created_at' => '2026-02-30T10:00:00Z']];
        $missing = self::row();
        unset($missing['updated_at']);
        yield 'missing field' => [$missing];
    }

    public function testPageDecoderBindsSnapshotFiltersOrderingAndCursor(): void
    {
        $criteria = PushSuppressionsContract::listOptions([
            'platform' => 'fcm',
            'reason' => 'manual',
            'hash_prefix' => '01234567',
            'limit' => 1,
        ]);
        $page = PushSuppressionsContract::decodePage([
            'tenantId' => self::TENANT,
            'items' => [self::row()],
            'total' => 2,
            'nextCursor' => 'eyJ2IjoxfQ',
            'snapshotAt' => '2026-08-28T12:00:00Z',
        ], self::TENANT, $criteria);
        $this->assertSame('eyJ2IjoxfQ', $page['nextCursor']);
        $this->assertSame(self::TENANT, $page['items'][0]['tenant_id']);

        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodePage([
            'tenantId' => self::OTHER_TENANT,
            'items' => [self::row()],
            'total' => 1,
            'snapshotAt' => '2026-08-28T12:00:00Z',
        ], self::TENANT, ['limit' => 1]));
        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodePage([
            'tenantId' => self::TENANT,
            'items' => [self::row()],
            'total' => 2,
            'snapshotAt' => '2026-08-28T12:00:00Z',
        ], self::TENANT, ['limit' => 1]));

        $rollbackPage = PushSuppressionsContract::decodePage([
            'tenantId' => self::TENANT,
            'items' => [self::row(['created_at' => '2026-08-29T00:00:00Z', 'updated_at' => '2026-08-29T00:00:00Z'])],
            'total' => 1,
            'snapshotAt' => '2026-08-28T12:00:00Z',
        ], self::TENANT, ['limit' => 1]);
        $this->assertSame('2026-08-29T00:00:00Z', $rollbackPage['items'][0]['created_at']);
    }

    public function testPageDecoderRejectsDuplicateOrUnorderedRows(): void
    {
        $base = [
            'tenantId' => self::TENANT,
            'total' => 2,
            'snapshotAt' => '2026-08-28T12:00:00Z',
        ];
        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodePage([
            ...$base,
            'items' => [self::row(), self::row()],
        ], self::TENANT, ['limit' => 2]));
        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodePage([
            ...$base,
            'items' => [
                self::row(),
                self::lockedRow(['created_at' => '2026-08-28T10:01:00Z', 'updated_at' => '2026-08-28T10:01:00Z']),
            ],
        ], self::TENANT, ['limit' => 2]));
    }

    public function testCasDeleteReceiptIsExactAndTenantBound(): void
    {
        $expected = ['id' => self::ID, 'expected_version' => 4];
        $receipt = [
            'ok' => true,
            'tenantId' => self::TENANT,
            'id' => self::ID,
            'version' => 5,
            'stillSuppressed' => false,
        ];
        $this->assertSame($receipt, PushSuppressionsContract::decodeDelete(
            $receipt,
            self::TENANT,
            $expected
        ));
        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodeDelete(
            [...$receipt, 'version' => 4],
            self::TENANT,
            $expected
        ));
        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodeDelete(
            [...$receipt, 'tenantId' => self::OTHER_TENANT],
            self::TENANT,
            $expected
        ));
    }

    public function testBulkInputsAreAtomicBoundedStrictAndDeduplicated(): void
    {
        $token = 'token-' . str_repeat('x', 24);
        $add = ['device_token' => $token, 'platform' => 'fcm', 'reason' => 'manual'];
        $remove = ['id' => self::ID, 'expected_version' => 1];
        $this->assertSame([$add], PushSuppressionsContract::bulkImportInputs([$add]));
        $this->assertSame([$remove], PushSuppressionsContract::bulkRemoveInputs([$remove]));

        foreach ([[], array_fill(0, 101, $add), [$add, $add]] as $invalid) {
            try {
                PushSuppressionsContract::bulkImportInputs($invalid);
                $this->fail('Expected invalid atomic bulk import to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringNotContainsString($token, $error->getMessage());
            }
        }
        foreach ([[], array_fill(0, 101, $remove), [$remove, $remove]] as $invalid) {
            try {
                PushSuppressionsContract::bulkRemoveInputs($invalid);
                $this->fail('Expected invalid atomic bulk removal to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('Push suppression', $error->getMessage());
            }
        }
    }

    public function testBulkReceiptsBindEveryRowAndCasReceiptInOrder(): void
    {
        $token = 'token-' . str_repeat('x', 24);
        $imports = PushSuppressionsContract::bulkImportInputs([
            ['device_token' => $token, 'platform' => 'fcm', 'reason' => 'manual'],
            ['device_token' => str_repeat('a', 64), 'platform' => 'apns', 'reason' => 'manual'],
        ]);
        $importReceipt = PushSuppressionsContract::decodeBulkImport([
            'ok' => true,
            'tenantId' => self::TENANT,
            'created' => 1,
            'existing' => 1,
            'items' => [self::row(), self::row([
                'id' => self::SECOND_ID,
                'device_token_hash' => 'aaaabbbbccccdddd',
                'platform' => 'apns',
            ])],
        ], self::TENANT, $imports);
        $this->assertSame(2, count($importReceipt['items']));
        $this->assertArrayNotHasKey('device_token', $importReceipt['items'][0]);

        $removals = PushSuppressionsContract::bulkRemoveInputs([
            ['id' => self::ID, 'expected_version' => 1],
            ['id' => self::SECOND_ID, 'expected_version' => 3],
        ]);
        $removeReceipt = PushSuppressionsContract::decodeBulkRemove([
            'ok' => true,
            'tenantId' => self::TENANT,
            'removed' => 2,
            'stillSuppressed' => 1,
            'items' => [
                [
                    'ok' => true,
                    'tenantId' => self::TENANT,
                    'id' => self::ID,
                    'version' => 2,
                    'stillSuppressed' => false,
                ],
                [
                    'ok' => true,
                    'tenantId' => self::TENANT,
                    'id' => self::SECOND_ID,
                    'version' => 4,
                    'stillSuppressed' => true,
                ],
            ],
        ], self::TENANT, $removals);
        $this->assertSame(1, $removeReceipt['stillSuppressed']);

        self::assertContractRejects(static fn (): array => PushSuppressionsContract::decodeBulkRemove([
            ...$removeReceipt,
            'stillSuppressed' => 0,
        ], self::TENANT, $removals));
    }

    public function testReadmeDocumentsExactAdminPrivacyCasAndDeliveryHold(): void
    {
        $readme = preg_replace(
            '/\s+/u',
            ' ',
            (string) file_get_contents(dirname(__DIR__) . '/README.md')
        );
        $this->assertIsString($readme);
        foreach (['list', 'add', 'remove', 'bulkImport', 'bulkRemove'] as $method) {
            $this->assertStringContainsString($method, $readme);
        }
        $this->assertStringContainsString('exact-admin credential', $readme);
        $this->assertStringContainsString('tenant-customer APNs/FCM/Web registry', $readme);
        $this->assertStringContainsString('not operator Expo-device management', $readme);
        $this->assertStringContainsString('minimized 16-hex', $readme);
        $this->assertStringContainsString('never the raw customer token or full digest', $readme);
        $this->assertStringContainsString('expected_version', $readme);
        $this->assertStringContainsString('stillSuppressed', $readme);
        $this->assertStringContainsString('HOLD / NO-GO', $readme);
        $this->assertStringContainsString('automatic provider feedback', $readme);
        $this->assertStringContainsString('Web is registry-only', $readme);
    }
}
