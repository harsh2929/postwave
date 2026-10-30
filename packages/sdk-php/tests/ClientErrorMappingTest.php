<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\NetworkError;
use Moosewave\Errors\ParseError;
use Moosewave\Errors\WrongRegionError;

/**
 * Covers the canonical error-taxonomy wiring inside Client::request and
 * Client::buildError. These are the regressions the adversarial review
 * flagged:
 *   - a malformed-JSON 2xx body must raise ParseError (not NetworkError);
 *   - a 421 must resolve `region` from the JSON envelope when the
 *     X-Postwave-Region header is absent (mirroring correctEndpoint).
 */
final class ClientErrorMappingTest extends TestCase
{
    /**
     * Spin up a one-shot loopback HTTP server that returns a fixed raw
     * response, then point a real Client at it. This exercises the curl
     * transport + parse path end-to-end, which is the only way to reach
     * the inline json_decode failure branch in Client::request.
     *
     * @return array{0: int, 1: string} [port, pid-ish handle]
     */
    private function serveOnce(string $rawResponse): int
    {
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
            // Child: accept one connection, write the canned response, exit.
            $conn = stream_socket_accept($server, 5);
            if ($conn !== false) {
                // Drain the request line/headers so curl gets a clean close.
                stream_set_timeout($conn, 1);
                fread($conn, 8192);
                fwrite($conn, $rawResponse);
                fclose($conn);
            }
            fclose($server);
            exit(0);
        }
        fclose($server);
        return $port;
    }

    private function requireForkingSupport(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
    }

    public function testMalformedJsonSuccessBodyRaisesParseError(): void
    {
        $this->requireForkingSupport();

        $body = '{not json';
        $raw = "HTTP/1.1 200 OK\r\n"
            . "Content-Type: application/json\r\n"
            . 'Content-Length: ' . strlen($body) . "\r\n"
            . "Connection: close\r\n"
            . "\r\n"
            . $body;

        $port = $this->serveOnce($raw);
        $client = new Client('pw_test_parse', "http://127.0.0.1:$port");

        try {
            $client->request('GET', '/api/v1/me');
            $this->fail('expected ParseError');
        } catch (ParseError $e) {
            // Canonical taxonomy: ParseError, NOT NetworkError.
            $this->assertSame('invalid_json', $e->code);
            $this->assertSame('invalid_json', $e->getErrorCode());
            $this->assertTrue(isset($e->code));
            $this->assertSame(0, $e->getCode());
            $this->assertFalse($e instanceof NetworkError);
        } finally {
            pcntl_wait($status);
        }
    }

    /**
     * Finding 3: 421 region must fall back to the JSON envelope when the
     * X-Postwave-Region response header is missing — symmetric with how
     * correctEndpoint already falls back to error.correct_endpoint.
     */
    public function testWrongRegionResolvesRegionFromEnvelopeWhenHeaderMissing(): void
    {
        $build = new \ReflectionMethod(Client::class, 'buildError');

        $parsed = [
            'error' => [
                'code' => 'wrong_region',
                'message' => 'tenant lives elsewhere',
                'correct_endpoint' => 'https://eu-central-1.api.moosewave.com',
                'region' => 'eu-central-1',
            ],
        ];
        // No location / x-postwave-region headers — force the envelope path.
        $err = $build->invoke(null, 421, $parsed, json_encode($parsed), []);

        $this->assertInstanceOf(WrongRegionError::class, $err);
        $this->assertSame('eu-central-1', $err->region);
        $this->assertSame('https://eu-central-1.api.moosewave.com', $err->correctEndpoint);
    }

    public function testWrongRegionHeaderStillWinsOverEnvelope(): void
    {
        $build = new \ReflectionMethod(Client::class, 'buildError');

        $parsed = [
            'error' => [
                'code' => 'wrong_region',
                'message' => 'tenant lives elsewhere',
                'region' => 'eu-central-1',
            ],
        ];
        $headers = ['x-postwave-region' => 'us-east-1', 'location' => 'https://us-east-1.api.moosewave.com'];
        $err = $build->invoke(null, 421, $parsed, json_encode($parsed), $headers);

        $this->assertInstanceOf(WrongRegionError::class, $err);
        $this->assertSame('us-east-1', $err->region);
        $this->assertSame('https://us-east-1.api.moosewave.com', $err->correctEndpoint);
    }
}
