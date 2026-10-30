<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\DiscountsResource;

/** The PHP SDK exposes only the sanitized discount-history reads. */
final class DiscountsResourceContractTest extends TestCase
{
    private static function reflection(): \ReflectionClass
    {
        return new \ReflectionClass(DiscountsResource::class);
    }

    private static function source(): string
    {
        return file_get_contents(self::reflection()->getFileName());
    }

    public function testClientExposesDiscountHistoryResource(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(DiscountsResource::class, $client->discounts);
    }

    public function testSurfaceContainsExactlyTheTwoReadMethods(): void
    {
        $methods = array_map(
            static fn (\ReflectionMethod $method): string => $method->getName(),
            array_filter(
                self::reflection()->getMethods(\ReflectionMethod::IS_PUBLIC),
                static fn (\ReflectionMethod $method): bool =>
                    $method->getDeclaringClass()->getName() === DiscountsResource::class
            )
        );
        sort($methods);

        $this->assertSame(['list', 'redemptions'], $methods);
        $this->assertSame(2, substr_count(self::source(), "'GET'"));
        foreach (["'POST'", "'PUT'", "'PATCH'", "'DELETE'"] as $verb) {
            $this->assertStringNotContainsString($verb, self::source());
        }
        foreach (['redemptions.csv', 'tenant-scoped discount codes'] as $staleClaim) {
            $this->assertStringNotContainsString($staleClaim, self::source());
        }
        $this->assertStringNotContainsString('function check(', self::source());
    }

    public function testListUsesTheSameStrictBoundedPaginationContract(): void
    {
        $source = self::source();
        $this->assertStringContainsString(
            "?string \$recordId = null",
            $source
        );
        $this->assertStringContainsString("'record_id' => \$recordId", $source);
        $this->assertStringContainsString(
            "request('GET', '/api/v1/discounts', null, \$query)",
            $source
        );
        $this->assertStringContainsString('has_more: bool', $source);
    }

    public function testRedemptionsUsesAnOpaqueCanonicalRecordIdAndBoundedQuery(): void
    {
        $source = self::source();
        $this->assertStringContainsString(
            "'/api/v1/discounts/' . rawurlencode(\$recordId) . '/redemptions'",
            $source
        );
        $this->assertStringContainsString("'limit' => self::boundedInteger('limit', \$limit, 1, 100)", $source);
        $this->assertStringContainsString("'offset' => self::boundedInteger('offset', \$offset, 0, 10000)", $source);
    }

    public function testInvalidRecordIdsFailBeforeTransport(): void
    {
        $client = new Client('pw_test_no_transport', 'http://127.0.0.1:1', 1);
        foreach ([
            '',
            'SAVE20',
            'a1b2c3d4e5f64789abcdef0123456789',
            ' a1b2c3d4-e5f6-4789-abcd-ef0123456789',
            'a1b2c3d4-e5f6-4789-abcd-ef012345678',
        ] as $recordId) {
            try {
                $client->discounts->list(null, null, $recordId);
                $this->fail('Expected an invalid discount list record_id to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('record_id', $error->getMessage());
            }
            try {
                $client->discounts->redemptions($recordId);
                $this->fail('Expected an invalid discount record_id to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('record_id', $error->getMessage());
            }
        }
    }

    public function testInvalidPaginationFailsBeforeTransport(): void
    {
        $client = new Client('pw_test_no_transport', 'http://127.0.0.1:1', 1);
        $recordId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
        foreach ([[0, null], [101, null], [null, -1], [null, 10001]] as [$limit, $offset]) {
            try {
                $client->discounts->list($limit, $offset);
                $this->fail('Expected invalid discount-history list pagination to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('Discount history', $error->getMessage());
            }
            try {
                $client->discounts->redemptions($recordId, $limit, $offset);
                $this->fail('Expected invalid discount-history pagination to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('Discount history', $error->getMessage());
            }
        }
    }
}
