<?php
// Verifying Pin Bridge webhooks in PHP 7.4+.
// Use the RAW request body (file_get_contents('php://input')), not a re-encoded array.

function verifyPinBridgeWebhook(string $rawBody, string $signatureHeader, string $secret, int $tolerance = 300): bool
{
    $parts = [];
    foreach (explode(',', $signatureHeader) as $part) {
        [$key, $value] = array_pad(explode('=', $part, 2), 2, '');
        $parts[$key] = $value;
    }
    if (!isset($parts['t'], $parts['v1']) || !ctype_digit($parts['t']) || abs(time() - (int) $parts['t']) > $tolerance) {
        return false;
    }
    $expected = hash_hmac('sha256', $parts['t'] . '.' . $rawBody, $secret);
    return hash_equals($expected, $parts['v1']);
}

// Typical endpoint:
// $raw = file_get_contents('php://input');
// if (!verifyPinBridgeWebhook($raw, $_SERVER['HTTP_X_PINBRIDGE_SIGNATURE'] ?? '', getenv('PB_WEBHOOK_SECRET'))) {
//     http_response_code(401); exit;
// }
// $event = json_decode($raw, true);
// // Deduplicate by $event['id'], then process and answer 2xx quickly.
// http_response_code(204);

if (PHP_SAPI === 'cli' && isset($argv[1]) && $argv[1] === '--self-check') {
    $body = '{"id":"e1","type":"ping"}';
    $t = (string) time();
    $header = 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $body, 'secret');
    var_dump(verifyPinBridgeWebhook($body, $header, 'secret'), verifyPinBridgeWebhook($body, $header, 'wrong'));
}
