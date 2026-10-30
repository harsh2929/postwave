<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Resources\AssetsResource;

/** Public Assets SDK surface must track the curated OpenAPI lifecycle. */
final class AssetsResourceContractTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(AssetsResource::class))->getFileName());
    }

    public function testPublicLifecycleMethodsExist(): void
    {
        foreach (['upload', 'list', 'get', 'update', 'usage', 'delete'] as $method) {
            $this->assertTrue(method_exists(AssetsResource::class, $method), "Missing AssetsResource::$method");
        }
    }

    public function testUpdateAndForceDeleteUseExactWireFields(): void
    {
        $source = self::source();
        $this->assertStringContainsString("'alt_text' => \$altText", $source);
        $this->assertStringContainsString("['force' => \$force]", $source);
        $delete = new \ReflectionMethod(AssetsResource::class, 'delete');
        $this->assertSame(false, $delete->getParameters()[1]->getDefaultValue());
    }
}
