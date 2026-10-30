<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

class NetworkError extends PostwaveError
{
    public function __construct(string $message, string $code = 'network_error')
    {
        parent::__construct($message, 0, $code);
    }
}
