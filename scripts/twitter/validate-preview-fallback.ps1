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
$livePreviewUrl = $null
$safePreviewUrl = $null
$smoke = $null

try {
  Set-PreviewValue 'TWITTER_WORKER_SECRET' $previewSecret
  Set-PreviewValue 'TWITTER_FALLBACK_ENABLED' 'true'
  Set-PreviewValue 'TWITTER_FALLBACK_LIVE_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_FALLBACK_STALE_SECONDS' '120'
  Set-PreviewValue 'TWITTER_PUBLICATION_WORKER_ENABLED' 'true'
  Set-PreviewValue 'TWITTER_PUBLICATION_MODE' 'shadow'
  $livePreviewUrl = Deploy-Preview
  $smokeResult = Invoke-VercelCapture @('curl', '/api/internal/twitter-fallback-dispatch', '--deployment', $livePreviewUrl, '--', '--request', 'POST', '--header', "x-twitter-worker-secret: $previewSecret", '--header', 'content-type: application/json', '--data', '{}')
  $smokeOutput = $smokeResult.Output
  if ($smokeResult.ExitCode -ne 0) { throw "Smoke fallback falhou: $($smokeOutput -join ' ')" }
  $smokeText = ($smokeOutput | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
  if (-not $smokeText) { throw 'Resposta JSON do fallback não foi encontrada.' }
  $smoke = $smokeText | ConvertFrom-Json
  if ($smoke.fallback -ne $true -or $smoke.mode -ne 'shadow' -or [int]$smoke.claimed -ne 0) {
    throw "Resposta inesperada do fallback: $smokeText"
  }
}
finally {
  Set-PreviewValue 'TWITTER_FALLBACK_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_FALLBACK_LIVE_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_PUBLICATION_WORKER_ENABLED' 'false'
  Set-PreviewValue 'TWITTER_PUBLICATION_MODE' 'shadow'
  $safePreviewUrl = Deploy-Preview
  [Array]::Clear($secretBytes, 0, $secretBytes.Length)
  $previewSecret = $null
}

[ordered]@{
  livePreviewUrl = $livePreviewUrl
  smoke = $smoke
  safePreviewUrl = $safePreviewUrl
  restored = $true
} | ConvertTo-Json -Depth 5
