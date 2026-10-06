<?php
// Minimal Pin Bridge client for PHP 7.4+ with ext-curl.
// Usage: PB_URL=https://bridge.duckcrm.one PB_API_KEY=... PB_SIGNING_SECRET=... php sign-request.php

function pinBridgeRequest(string $method, string $path, $body = null): array
{
    $payload = $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $timestamp = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $canonical = implode("\n", [$timestamp, $nonce, strtoupper($method), $path, hash('sha256', $payload)]);
    $signature = 'v1=' . hash_hmac('sha256', $canonical, getenv('PB_SIGNING_SECRET'));

    $headers = [
        'Authorization: Bearer ' . getenv('PB_API_KEY'),
        'X-Timestamp: ' . $timestamp,
        'X-Nonce: ' . $nonce,
        'X-Signature: ' . $signature,
    ];
    if ($payload !== '') {
        $headers[] = 'Content-Type: application/json';
    }

    $ch = curl_init((getenv('PB_URL') ?: 'https://bridge.duckcrm.one') . $path);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => strtoupper($method),
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    if ($payload !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload); // send exactly the bytes that were signed
    }
    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    return ['status' => $status, 'body' => json_decode((string) $response, true)];
}

var_export(pinBridgeRequest('GET', '/v1/me'));
echo PHP_EOL;
