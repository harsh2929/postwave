<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

class AuthError extends PostwaveError
{
    public function __construct(string $message, string $code, ?string $requestId = null)
    {
        parent::__construct($message, 401, $code, $requestId);
    }
}
