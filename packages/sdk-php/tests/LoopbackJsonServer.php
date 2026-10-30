<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

/** @internal Focused transport-test fixture; never used by the SDK itself. */
final class LoopbackJsonServer
{
    private bool $waited = false;

    private function __construct(
        public readonly int $port,
        private readonly int $pid,
        private readonly string $capturePath
    ) {
    }

    /**
     * @param list<array{status?: int, body?: mixed, headers?: array<string, string>}> $responses
     */
    public static function start(array $responses): self
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            throw new \RuntimeException('LoopbackJsonServer requires pcntl and stream sockets');
        }
        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        if ($server === false) {
            throw new \RuntimeException("cannot bind loopback socket: $errstr ($errno)");
        }
        $name = stream_socket_get_name($server, false);
        if (!is_string($name)) {
            fclose($server);
            throw new \RuntimeException('cannot resolve loopback socket address');
        }
        $port = (int) substr($name, (int) strrpos($name, ':') + 1);
        $capturePath = tempnam(sys_get_temp_dir(), 'postwave-php-transport-');
        if ($capturePath === false) {
            fclose($server);
            throw new \RuntimeException('cannot allocate transport capture file');
        }

        $pid = pcntl_fork();
        if ($pid === -1) {
            fclose($server);
            @unlink($capturePath);
            throw new \RuntimeException('cannot fork loopback server');
        }
        if ($pid === 0) {
            foreach ($responses as $response) {
                $connection = stream_socket_accept($server, 5);
                if ($connection === false) {
                    break;
                }
                stream_set_timeout($connection, 2);
                $request = self::readRequest($connection);
                file_put_contents($capturePath, base64_encode($request) . "\n", FILE_APPEND | LOCK_EX);

                $status = $response['status'] ?? 200;
                $body = array_key_exists('body', $response)
                    ? json_encode($response['body'], JSON_UNESCAPED_SLASHES)
                    : '{}';
                if (!is_string($body)) {
                    $body = '{}';
                }
                $reason = match ($status) {
                    200 => 'OK',
                    201 => 'Created',
                    202 => 'Accepted',
                    default => 'Response',
                };
                $headers = [
                    'Content-Type' => 'application/json',
                    'Content-Length' => (string) strlen($body),
                    'Connection' => 'close',
                ];
                foreach ($response['headers'] ?? [] as $name => $value) {
                    $headers[$name] = $value;
                }
                $raw = "HTTP/1.1 $status $reason\r\n";
                foreach ($headers as $name => $value) {
                    $raw .= "$name: $value\r\n";
                }
                $raw .= "\r\n" . $body;
                fwrite($connection, $raw);
                fclose($connection);
            }
            fclose($server);
            exit(0);
        }

        fclose($server);
        return new self($port, $pid, $capturePath);
    }

    /**
     * Wait for the fixture and return parsed request captures.
     *
     * @return list<array{method: string, target: string, headers: array<string, string>, body: string}>
     */
    public function requests(): array
    {
        if (!$this->waited) {
            pcntl_waitpid($this->pid, $status);
            $this->waited = true;
        }
        $raw = file_get_contents($this->capturePath);
        @unlink($this->capturePath);
        if (!is_string($raw) || $raw === '') {
            return [];
        }
        $requests = [];
        foreach (array_filter(explode("\n", trim($raw))) as $encoded) {
            $request = base64_decode($encoded, true);
            if (!is_string($request)) {
                continue;
            }
            [$head, $body] = array_pad(explode("\r\n\r\n", $request, 2), 2, '');
            $lines = explode("\r\n", $head);
            $requestLine = array_shift($lines) ?? '';
            [$method, $target] = array_pad(explode(' ', $requestLine, 3), 2, '');
            $headers = [];
            foreach ($lines as $line) {
                if (!str_contains($line, ':')) {
                    continue;
                }
                [$name, $value] = explode(':', $line, 2);
                $headers[strtolower(trim($name))] = trim($value);
            }
            $requests[] = [
                'method' => $method,
                'target' => $target,
                'headers' => $headers,
                'body' => $body,
            ];
        }
        return $requests;
    }

    private static function readRequest(mixed $connection): string
    {
        $request = '';
        while (!str_contains($request, "\r\n\r\n") && !feof($connection)) {
            $chunk = fread($connection, 8192);
            if (!is_string($chunk) || $chunk === '') {
                break;
            }
            $request .= $chunk;
        }
        [$head, $body] = array_pad(explode("\r\n\r\n", $request, 2), 2, '');
        $length = 0;
        if (preg_match('/\r\nContent-Length:\s*(\d+)/i', "\r\n" . $head, $matches) === 1) {
            $length = (int) $matches[1];
        }
        while (strlen($body) < $length && !feof($connection)) {
            $chunk = fread($connection, $length - strlen($body));
            if (!is_string($chunk) || $chunk === '') {
                break;
            }
            $body .= $chunk;
        }
        return $head . "\r\n\r\n" . substr($body, 0, $length);
    }
}
