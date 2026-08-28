$ErrorActionPreference = 'Stop'

function New-RandomSecret {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes); return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  finally { $generator.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Set-VercelValue([string]$Name, [string]$Environment, [string]$Value) {
  $Value | vercel env add $Name $Environment --force | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao configurar $Name em $Environment." }
}

$connectProduction = New-RandomSecret
$connectPreview = New-RandomSecret
$observabilityProduction = New-RandomSecret
$observabilityPreview = New-RandomSecret
try {
  Set-VercelValue 'TWITTER_CONNECT_WORKER_SECRET' 'production' $connectProduction
  Set-VercelValue 'TWITTER_CONNECT_WORKER_SECRET' 'preview' $connectPreview
  Set-VercelValue 'TWITTER_OBSERVABILITY_WORKER_SECRET' 'production' $observabilityProduction
  Set-VercelValue 'TWITTER_OBSERVABILITY_WORKER_SECRET' 'preview' $observabilityPreview
  Set-VercelValue 'TWITTER_CONNECT_WORKER_ENABLED' 'production' 'true'
  Set-VercelValue 'TWITTER_CONNECT_WORKER_ENABLED' 'preview' 'false'
  Set-VercelValue 'TWITTER_OBSERVABILITY_WORKER_ENABLED' 'production' 'true'
  Set-VercelValue 'TWITTER_OBSERVABILITY_WORKER_ENABLED' 'preview' 'false'
  Set-VercelValue 'TWITTER_OBSERVABILITY_POLL_INTERVAL_MS' 'production' '60000'
  Set-VercelValue 'TWITTER_OBSERVABILITY_POLL_INTERVAL_MS' 'preview' '60000'

  $payload = @{
    TWITTER_CONNECT_WORKER_SECRET = $connectProduction
    TWITTER_CONNECT_WORKER_ENABLED = 'true'
    TWITTER_CONNECT_WORKER_LIMIT = '2'
    TWITTER_OBSERVABILITY_WORKER_SECRET = $observabilityProduction
    TWITTER_OBSERVABILITY_WORKER_ENABLED = 'true'
    TWITTER_OBSERVABILITY_POLL_INTERVAL_MS = '60000'
  } | ConvertTo-Json -Compress
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
const backup=target+'.backup-observability-'+stamp;
const temp=target+'.observability-'+process.pid;
fs.copyFileSync(target,backup);fs.chmodSync(backup,0o600);
fs.writeFileSync(temp,lines.join('\n')+'\n',{mode:0o600});
fs.renameSync(temp,target);fs.chmodSync(target,0o600);
process.stdout.write(JSON.stringify({updated:Object.keys(values).sort(),mode:(fs.statSync(target).mode&0o777).toString(8),backup}));
'@
  $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
  $remoteCommand = "node -e `"eval(Buffer.from(process.argv[1],'base64').toString('utf8'))`" $encodedScript"
  $remoteAudit = $payload | ssh -i C:\Users\guilh\.ssh\athena_vps_worker_ed25519 -o BatchMode=yes -o ConnectTimeout=10 root@179.198.110.201 $remoteCommand | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $remoteAudit.mode -ne '600' -or $remoteAudit.updated.Count -ne 6) { throw 'Auditoria remota falhou.' }
  [ordered]@{ productionConfigured = @('connect', 'observability'); previewConfigured = @('connect', 'observability'); vpsUpdated = $remoteAudit.updated; vpsMode = $remoteAudit.mode; vpsBackup = $remoteAudit.backup; valuesPrinted = $false } | ConvertTo-Json -Depth 4
}
finally {
  $connectProduction = $null; $connectPreview = $null
  $observabilityProduction = $null; $observabilityPreview = $null
  $payload = $null
}
