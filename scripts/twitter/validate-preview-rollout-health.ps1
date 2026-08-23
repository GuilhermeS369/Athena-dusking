$ErrorActionPreference = 'Stop'

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
  $output = $result.Output
  if ($result.ExitCode -ne 0) { throw "Deploy Preview falhou: $($output -join ' ')" }
  $text = $output -join "`n"
  $matches = [regex]::Matches($text, 'https://pomodoro-[a-z0-9-]+\.vercel\.app')
  if ($matches.Count -eq 0) { throw 'URL do deploy Preview não foi encontrada.' }
  return $matches[$matches.Count - 1].Value
}

$secretBytes = [byte[]]::new(32)
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomGenerator.GetBytes($secretBytes) }
finally { $randomGenerator.Dispose() }
$previewSecret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

try {
  Set-PreviewValue 'TWITTER_ROLLOUT_HEALTH_SECRET' $previewSecret
  Set-PreviewValue 'TWITTER_MODULE_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_CANARY_ORGANIZATION_IDS' ','
  Set-PreviewValue 'TWITTER_PUBLICATION_WORKER_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_SYNC_WORKER_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_ANALYTICS_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_ANALYTICS_WORKER_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_RECONCILE_WORKER_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_FALLBACK_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_FALLBACK_LIVE_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_ROLLOUT_HEALTH_STALE_SECONDS' '120'

  $previewUrl = Deploy-Preview
  $smokeResult = Invoke-VercelCapture @('curl', '/api/internal/twitter-rollout-health', '--deployment', $previewUrl, '--', '--header', "x-twitter-worker-secret: $previewSecret")
  $smokeOutput = $smokeResult.Output
  if ($smokeResult.ExitCode -ne 0) { throw "Smoke de saúde X falhou: $($smokeOutput -join ' ')" }
  $smokeText = ($smokeOutput | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
  if (-not $smokeText) { throw 'Resposta JSON da saúde X não foi encontrada.' }
  $smoke = $smokeText | ConvertFrom-Json

  if ($smoke.status -eq 'unhealthy') { throw "Saúde X retornou crítica: $smokeText" }
  if ($smoke.module.enabled -or $smoke.module.globalEnabled -or [int]$smoke.module.canaryOrganizationCount -ne 0 -or $smoke.module.publicationWorkerEnabled -or $smoke.module.analyticsEnabled -or $smoke.module.fallbackEnabled -or $smoke.module.fallbackLiveEnabled) {
    throw 'Alguma flag de mutação X ficou habilitada no Preview.'
  }
  if ([int]$smoke.publicationQueue.nonTerminal -ne 0 -or [int]$smoke.holds.active -ne 0 -or [int]$smoke.holds.outcomeUnknown -ne 0 -or [int]$smoke.holds.reservationOutcomeUnknown -ne 0) {
    throw "Estado X inesperado no smoke read-only: $smokeText"
  }

  [ordered]@{
    previewUrl = $previewUrl
    status = $smoke.status
    publicationQueue = $smoke.publicationQueue
    analyticsQueue = $smoke.analyticsQueue
    holds = $smoke.holds
    rateLimits24h = $smoke.rateLimits24h
    wallets = $smoke.wallets
    signals = $smoke.signals
    checkedAt = $smoke.checkedAt
    mutationFlagsOff = $true
  } | ConvertTo-Json -Depth 8
}
finally {
  [Array]::Clear($secretBytes, 0, $secretBytes.Length)
  $previewSecret = $null
}
