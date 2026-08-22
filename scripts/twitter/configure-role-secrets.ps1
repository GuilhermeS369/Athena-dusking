$ErrorActionPreference = 'Stop'

$workerSecretNames = @(
  'TWITTER_PUBLICATION_WORKER_SECRET',
  'TWITTER_GENERATION_WORKER_SECRET',
  'TWITTER_SYNC_WORKER_SECRET',
  'TWITTER_ANALYTICS_WORKER_SECRET',
  'TWITTER_RECONCILE_WORKER_SECRET'
)
$vercelOnlySecretNames = @('TWITTER_FALLBACK_WORKER_SECRET', 'TWITTER_ROLLOUT_HEALTH_SECRET')
$allSecretNames = $workerSecretNames + $vercelOnlySecretNames

function New-RandomSecret {
  $bytes = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  try { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Set-VercelSecret([string]$Name, [string]$Environment, [string]$Value) {
  $Value | vercel env add $Name $Environment --force | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao configurar $Name em $Environment." }
}

$production = @{}
$preview = @{}
foreach ($name in $allSecretNames) {
  $production[$name] = New-RandomSecret
  $preview[$name] = New-RandomSecret
}

try {
  if (($production.Values | Select-Object -Unique).Count -ne $allSecretNames.Count) { throw 'Colisão inesperada entre segredos Production.' }
  if (($preview.Values | Select-Object -Unique).Count -ne $allSecretNames.Count) { throw 'Colisão inesperada entre segredos Preview.' }

  foreach ($name in $allSecretNames) {
    Set-VercelSecret $name 'production' $production[$name]
    Set-VercelSecret $name 'preview' $preview[$name]
  }

  $remoteValues = @{}
  foreach ($name in $workerSecretNames) { $remoteValues[$name] = $production[$name] }
  $payload = $remoteValues | ConvertTo-Json -Compress
  $remoteScript = @'
const fs=require('fs');
const target='/opt/athena-twitter/shared/.env.worker';
if(fs.realpathSync(target)!==target)throw new Error('Caminho remoto inesperado.');
const values=JSON.parse(fs.readFileSync(0,'utf8'));
let lines=fs.readFileSync(target,'utf8').split(/\r?\n/).filter((line,index,array)=>line.length>0||index<array.length-1);
for(const [name,value] of Object.entries(values)){
  let found=false;
  lines=lines.map(line=>{if(line.startsWith(name+'=')){found=true;return name+'='+value;}return line;});
  if(!found)lines.push(name+'='+value);
}
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+$/,'Z');
const backup=target+'.backup-'+stamp;
const temp=target+'.role-secrets-'+process.pid;
fs.copyFileSync(target,backup);fs.chmodSync(backup,0o600);
fs.writeFileSync(temp,lines.join('\n')+'\n',{mode:0o600});
fs.renameSync(temp,target);fs.chmodSync(target,0o600);
process.stdout.write(JSON.stringify({updated:Object.keys(values).sort(),mode:(fs.statSync(target).mode&0o777).toString(8),backup}));
'@
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
  $remoteCommand = "node -e `"eval(Buffer.from(process.argv[1],'base64').toString('utf8'))`" $encodedScript"
  $remoteResult = $payload | ssh -i C:\Users\guilh\.ssh\athena_vps_worker_ed25519 -o BatchMode=yes -o ConnectTimeout=10 root@179.198.110.201 $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao atualizar segredos por papel na VPS.' }
  $remoteAudit = $remoteResult | ConvertFrom-Json
  if ($remoteAudit.mode -ne '600' -or $remoteAudit.updated.Count -ne $workerSecretNames.Count) { throw 'Auditoria remota dos segredos falhou.' }

  [ordered]@{
    productionConfigured = $allSecretNames
    previewConfigured = $allSecretNames
    vpsConfigured = $remoteAudit.updated
    vpsMode = $remoteAudit.mode
    vpsBackup = $remoteAudit.backup
    valuesPrinted = $false
  } | ConvertTo-Json -Depth 5
}
finally {
  foreach ($name in @($production.Keys)) { $production[$name] = $null }
  foreach ($name in @($preview.Keys)) { $preview[$name] = $null }
  $payload = $null
}
