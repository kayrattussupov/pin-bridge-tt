# Signed request to Pin Bridge from Windows (PowerShell 5.1+, curl.exe from Windows 10/11).
# Same as scripts/curl/pb.sh; run it through pb.cmd from cmd:
#
#   set PB_API_KEY=pb_...
#   set PB_SIGNING_SECRET=...
#   pb GET /v1/me
#   pb POST /v1/listings/validate @bodies\validate-ok.json
#   pb POST /v1/connections/<id>/confirm "{\"code\":\"123456\"}"
#
# Prints the response body, then "HTTP <status>" on the last line.
# /v1/platform/... is signed with PB_PLATFORM_SIGNING_SECRET and sent without Authorization.
# Optional: PB_URL, PB_IDEMPOTENCY_KEY, and for negative tests PB_TIMESTAMP, PB_NONCE,
# PB_SIGNATURE. PB_SHOW_HEADERS=1 also prints response headers. PB_DRY_RUN=1 prints the canonical string and signature without sending.
param(
  [Parameter(Mandatory = $true)][string]$Method,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Body = ''
)
$ErrorActionPreference = 'Stop'

function Hex([byte[]]$bytes) { ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' }

$url = if ($env:PB_URL) { $env:PB_URL.TrimEnd('/') } else { 'https://bridge.duckcrm.one' }
$platform = $Path.StartsWith('/v1/platform/')
$secret = if ($platform) { $env:PB_PLATFORM_SIGNING_SECRET } else { $env:PB_SIGNING_SECRET }
if (-not $secret) {
  if ($platform) { throw 'set PB_PLATFORM_SIGNING_SECRET' } else { throw 'set PB_SIGNING_SECRET' }
}
if (-not $platform -and -not $env:PB_API_KEY) { throw 'set PB_API_KEY' }

# The exact bytes that go on the wire are the bytes that get hashed.
if ($Body.StartsWith('@')) {
  $bodyBytes = [IO.File]::ReadAllBytes((Resolve-Path $Body.Substring(1)))
  if ($bodyBytes.Length -ge 3 -and $bodyBytes[0] -eq 0xEF -and $bodyBytes[1] -eq 0xBB -and $bodyBytes[2] -eq 0xBF) {
    $bodyBytes = $bodyBytes[3..($bodyBytes.Length - 1)]
  }
} else {
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes($Body)
}

$method = $Method.ToUpperInvariant()
$timestamp = if ($env:PB_TIMESTAMP) { $env:PB_TIMESTAMP } else { [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
if ($env:PB_NONCE) {
  $nonce = $env:PB_NONCE
} else {
  $random = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
  $nonce = Hex $random
}
$bodyHash = Hex ([Security.Cryptography.SHA256]::Create().ComputeHash([byte[]]$bodyBytes))
$canonical = "$timestamp`n$nonce`n$method`n$Path`n$bodyHash"
$hmac = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($secret))
$signature = if ($env:PB_SIGNATURE) { $env:PB_SIGNATURE } else {
  'v1=' + (Hex $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))
}

if ($env:PB_DRY_RUN) {
  Write-Output $canonical
  Write-Output "X-Signature: $signature"
  exit 0
}

$curlArgs = @(
  '-sS', '-X', $method, "$url$Path",
  '-H', "X-Timestamp: $timestamp",
  '-H', "X-Nonce: $nonce",
  '-H', "X-Signature: $signature",
  '-w', '\nHTTP %{http_code}\n'
)
if (-not $platform) { $curlArgs += @('-H', "Authorization: Bearer $($env:PB_API_KEY)") }
if ($env:PB_SHOW_HEADERS) { $curlArgs += '-i' }
if ($env:PB_IDEMPOTENCY_KEY) { $curlArgs += @('-H', "Idempotency-Key: $($env:PB_IDEMPOTENCY_KEY)") }

$bodyFile = $null
try {
  if ($bodyBytes.Length -gt 0) {
    $bodyFile = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllBytes($bodyFile, [byte[]]$bodyBytes)
    $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile")
  }
  & "$env:SystemRoot\System32\curl.exe" @curlArgs
  exit $LASTEXITCODE
} finally {
  if ($bodyFile) { Remove-Item -LiteralPath $bodyFile -Force }
}
