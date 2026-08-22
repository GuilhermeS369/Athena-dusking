$ErrorActionPreference = 'Stop'

function New-RandomSecret {
  $bytes = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  try { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Set-PreviewValue([string]$Name, [string]$Value) {
  $Value | vercel env add $Name preview --force | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao configurar $Name no Preview." }
}

function Invoke-VercelCapture([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& vercel @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previousPreference }
  return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Deploy-Preview {
  $result = Invoke-VercelCapture @('deploy', '--yes')
  if ($result.ExitCode -ne 0) { throw "Deploy Preview falhou: $($result.Output -join ' ')" }
  $matches = [regex]::Matches(($result.Output -join "`n"), 'https://pomodoro-[a-z0-9-]+\.vercel\.app')
  if ($matches.Count -eq 0) { throw 'URL Preview ausente.' }
  return $matches[$matches.Count - 1].Value
}

function Invoke-PreviewJson([string]$Url, [string]$Path, [string]$Secret, [string]$Body = '{}') {
  $result = Invoke-VercelCapture @('curl', $Path, '--deployment', $Url, '--', '--request', 'POST', '--header', "x-twitter-worker-secret: $Secret", '--header', 'content-type: application/json', '--data', $Body)
  if ($result.ExitCode -ne 0) { throw "Chamada Preview falhou em $Path." }
  $json = $result.Output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $json) { throw "JSON ausente em $Path." }
  return $json | ConvertFrom-Json
}

$roles = [ordered]@{
  'athena-twitter-publication-worker' = 'TWITTER_PUBLICATION_WORKER_SECRET'
  'athena-twitter-generation-worker' = 'TWITTER_GENERATION_WORKER_SECRET'
  'athena-twitter-zernio-sync-worker' = 'TWITTER_SYNC_WORKER_SECRET'
  'athena-twitter-analytics-worker' = 'TWITTER_ANALYTICS_WORKER_SECRET'
  'athena-twitter-webhook-reconcile-worker' = 'TWITTER_RECONCILE_WORKER_SECRET'
}
$secrets = @{}
foreach ($secretName in $roles.Values) { $secrets[$secretName] = New-RandomSecret }
$secrets['TWITTER_FALLBACK_WORKER_SECRET'] = New-RandomSecret
$secrets['TWITTER_ROLLOUT_HEALTH_SECRET'] = New-RandomSecret

try {
  foreach ($entry in $secrets.GetEnumerator()) { Set-PreviewValue $entry.Key $entry.Value }
  foreach ($entry in @{
    TWITTER_MODULE_ENABLED = 'false'; TWITTER_CANARY_ORGANIZATION_IDS = ',';
    TWITTER_PUBLICATION_WORKER_ENABLED = 'false'; TWITTER_GENERATION_WORKER_ENABLED = 'false';
    TWITTER_SYNC_WORKER_ENABLED = 'false'; TWITTER_ANALYTICS_ENABLED = 'false';
    TWITTER_ANALYTICS_WORKER_ENABLED = 'false'; TWITTER_FALLBACK_ENABLED = 'false';
    TWITTER_FALLBACK_LIVE_ENABLED = 'false'; TWITTER_PUBLICATION_MODE = 'shadow'
  }.GetEnumerator()) { Set-PreviewValue $entry.Key $entry.Value }

  $previewUrl = Deploy-Preview
  $validated = @()
  foreach ($workerName in $roles.Keys) {
    $secret = $secrets[$roles[$workerName]]
    $heartbeat = Invoke-PreviewJson $previewUrl '/api/internal/twitter-heartbeat' $secret (@{ workerName = $workerName; workerId = 'preview-role-secret-validation'; metadata = @{ validation = $true } } | ConvertTo-Json -Compress)
    if ($heartbeat.ok -ne $true -or $heartbeat.mode -ne 'stopped') { throw "Heartbeat inesperado para $workerName." }
    $breaker = Invoke-PreviewJson $previewUrl '/api/internal/twitter-circuit-breaker' $secret (@{ workerName = $workerName; operation = 'success' } | ConvertTo-Json -Compress)
    if ($null -eq $breaker.allowed) { throw "Circuit breaker inesperado para $workerName." }
    $validated += $workerName
  }

  $crossRole = Invoke-PreviewJson $previewUrl '/api/internal/twitter-heartbeat' $secrets['TWITTER_ANALYTICS_WORKER_SECRET'] (@{ workerName = 'athena-twitter-publication-worker'; workerId = 'cross-role-must-fail' } | ConvertTo-Json -Compress)
  if ($crossRole.error -ne 'Não autorizado.') { throw 'Segredo de analytics foi aceito como publicação.' }

  $publication = Invoke-PreviewJson $previewUrl '/api/internal/twitter-publication-claims' $secrets['TWITTER_PUBLICATION_WORKER_SECRET'] '{}'
  $analytics = Invoke-PreviewJson $previewUrl '/api/internal/twitter-analytics-claims' $secrets['TWITTER_ANALYTICS_WORKER_SECRET'] '{}'
  $fallback = Invoke-PreviewJson $previewUrl '/api/internal/twitter-fallback-dispatch' $secrets['TWITTER_FALLBACK_WORKER_SECRET'] '{}'
  if ($publication.disabled -ne $true -or $analytics.disabled -ne $true -or $fallback.disabled -ne $true) { throw 'Algum claim/fallback não permaneceu desligado.' }

  $healthResult = Invoke-VercelCapture @('curl', '/api/internal/twitter-rollout-health', '--deployment', $previewUrl, '--', '--header', "x-twitter-worker-secret: $($secrets['TWITTER_ROLLOUT_HEALTH_SECRET'])")
  $healthJson = $healthResult.Output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if ($healthResult.ExitCode -ne 0 -or -not $healthJson) { throw 'Health Preview indisponível.' }
  $health = $healthJson | ConvertFrom-Json
  if ($health.status -ne 'ok' -or [int]$health.publicationQueue.nonTerminal -ne 0 -or [int]$health.holds.active -ne 0) { throw 'Health final não ficou ok.' }

  [ordered]@{
    previewUrl = $previewUrl
    workersValidated = $validated
    crossRoleRejected = $true
    publicationClaimDisabled = $true
    analyticsClaimDisabled = $true
    fallbackDisabled = $true
    health = $health.status
    valuesPrinted = $false
  } | ConvertTo-Json -Depth 6
}
finally {
  foreach ($name in @($secrets.Keys)) { $secrets[$name] = $null }
}
