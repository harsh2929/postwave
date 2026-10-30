<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Resources\AnalyticsResource;

final class AnalyticsEngagementReportingResourceTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(AnalyticsResource::class))->getFileName());
    }

    public function testEngagementReportingMethodsArePublic(): void
    {
        $this->assertTrue(method_exists(AnalyticsResource::class, 'engagementClassificationSummary'));
        $this->assertTrue(method_exists(AnalyticsResource::class, 'humanEngagedReach'));
        $this->assertTrue(method_exists(AnalyticsResource::class, 'exportHumanEngagedReachEvidence'));
    }

    public function testMethodsUseTheAuthenticatedAnalyticsReadRoutes(): void
    {
        $source = self::source();
        $this->assertStringContainsString(
            "'/api/v1/analytics/engagement-classification/summary'",
            $source
        );
        $this->assertStringContainsString(
            "'/api/v1/analytics/human-engaged-reach'",
            $source
        );
        $this->assertStringContainsString(
            "'/api/v1/analytics/human-engaged-reach/export'",
            $source
        );
        $this->assertStringContainsString(
            "'application/vnd.postwave.human-engaged-reach-evidence+json'",
            $source
        );
        $this->assertSame(3, substr_count($source, "'GET',\n            '/api/v1/analytics/"));
    }
}
