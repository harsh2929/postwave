<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Resources\IntegrationsResource;

final class IntegrationsResourceTest extends TestCase
{
    public function testPathSegmentEncodesDynamicIds(): void
    {
        $this->assertSame('hubspot%2Fcrm', IntegrationsResource::pathSegment('hubspot/crm'));
        $this->assertSame('recipe%2Fa', IntegrationsResource::pathSegment(' recipe/a ', 'recipe id'));
        $this->assertSame('conn%2F1', IntegrationsResource::pathSegment('conn/1', 'native integration id'));
    }

    public function testPathSegmentRejectsEmptyValues(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('integration slug is required');

        IntegrationsResource::pathSegment(' ');
    }
}
