<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\SequencesResource;

/** Fail-closed optimistic-concurrency contract for sequence mutations. */
final class SequencesResourceContractTest extends TestCase
{
    private static function source(): string
    {
        return file_get_contents((new \ReflectionClass(SequencesResource::class))->getFileName());
    }

    public function testMutationMethodsRequireExpectedVersion(): void
    {
        $update = new \ReflectionMethod(SequencesResource::class, 'update');
        $delete = new \ReflectionMethod(SequencesResource::class, 'delete');

        $this->assertSame(3, $update->getNumberOfRequiredParameters());
        $this->assertSame('expectedVersion', $update->getParameters()[2]->getName());
        $this->assertSame(2, $delete->getNumberOfRequiredParameters());
        $this->assertSame('expectedVersion', $delete->getParameters()[1]->getName());
    }

    public function testBothMutationsSendCanonicalIfMatchHeader(): void
    {
        $src = self::source();

        $this->assertSame(
            2,
            substr_count($src, "['If-Match' => self::sequenceIfMatch(\$expectedVersion)]")
        );
        $this->assertStringContainsString("return '\"' . \$expectedVersion . '\"';", $src);
    }

    public function testInvalidVersionFailsBeforeTransport(): void
    {
        $resource = (new Client('pw_test_sequence_cas'))->sequences;

        try {
            $resource->update('seq_1', ['name' => 'Unsafe'], 0);
            $this->fail('Expected invalid sequence revision to be rejected');
        } catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('positive integer', $error->getMessage());
        }

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('positive integer');
        $resource->delete('seq_1', -1);
    }
}
