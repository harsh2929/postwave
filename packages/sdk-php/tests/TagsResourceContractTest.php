<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\TagsResource;

/** Contract tests for the complete, versioned Tags resource surface. */
final class TagsResourceContractTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(TagsResource::class))->getFileName());
    }

    public function testClientExposesTagsResource(): void
    {
        $client = new Client('pw_test_resource_surface');
        $this->assertInstanceOf(TagsResource::class, $client->tags);
    }

    public function testSurfaceMatchesGateway(): void
    {
        foreach (['list', 'create', 'update', 'delete'] as $method) {
            $this->assertTrue(
                method_exists(TagsResource::class, $method),
                "TagsResource is missing $method()"
            );
        }
    }

    public function testListAndCreateExposeCompleteFields(): void
    {
        $src = self::source();
        foreach (['query', 'group_id', 'include_archived'] as $filter) {
            $this->assertStringContainsString("'$filter'", $src);
        }
        foreach (['color', 'description', 'group_id', 'pii'] as $field) {
            $this->assertStringContainsString("'$field'", $src);
        }
    }

    public function testUpdateUsesPatchEncodedIdAndIfMatch(): void
    {
        $src = self::source();
        $this->assertMatchesRegularExpression(
            '~request\(\s*\x27PATCH\x27,\s*\x27/api/v1/tags/\x27\s*\.\s*rawurlencode\(\$id\)~',
            $src
        );
        $this->assertStringContainsString("['If-Match' => \$etag]", $src);
    }

    public function testDeleteRemainsExplicitCompatibilityCall(): void
    {
        $src = self::source();
        $this->assertMatchesRegularExpression(
            '~request\(\s*\x27DELETE\x27,\s*\x27/api/v1/tags/\x27\s*\.\s*rawurlencode\(\$id\)~',
            $src
        );
        $this->assertStringContainsString('unsafe_mutation_disabled', $src);
    }
}
