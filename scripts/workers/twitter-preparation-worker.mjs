#!/usr/bin/env node
import os from 'node:os';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

for(const envPath of[path.resolve(process.cwd(),'.env.worker'),path.resolve(process.cwd(),'.env.local')]){
  if(!fs.existsSync(envPath))continue;
  for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){
    const match=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);if(!match||process.env[match[1]])continue;
    let value=match[2].trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);process.env[match[1]]=value;
  }
}
const required=name=>{const value=process.env[name];if(!value)throw new Error(`Variável obrigatória ausente: ${name}`);return value;};
const baseUrl=required('TWITTER_WORKER_APP_BASE_URL').replace(/\/$/,'');
const secret=required('TWITTER_PREPARATION_WORKER_SECRET');
const workerName='athena-twitter-preparation-worker';
const workerId=`preparation-${os.hostname()}-${process.pid}`;
const interval=Math.max(1000,Number.parseInt(process.env.TWITTER_WORKER_POLL_INTERVAL_MS??'5000',10)||5000);
const limit=Math.min(500,Math.max(1,Number.parseInt(process.env.TWITTER_PREPARATION_WORKER_LIMIT??'500',10)||500));
const once=process.argv.includes('--once');let stopping=false;
process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function post(endpoint,body){const response=await fetch(`${baseUrl}${endpoint}`,{method:'POST',headers:{'content-type':'application/json','x-twitter-worker-secret':secret},body:JSON.stringify(body)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error??`HTTP ${response.status}`);return payload;}
async function cycle(){const heartbeat=await post('/api/internal/twitter-heartbeat',{workerName,workerId,metadata:{role:'preparation',pid:process.pid,hostname:os.hostname(),limit}});if(heartbeat.allowed===false||heartbeat.mode==='stopped')return;await post('/api/internal/twitter-preparation-run',{workerId,limit});}
do{try{await cycle();await post('/api/internal/twitter-circuit-breaker',{workerName,operation:'success'});}catch(error){const message=error instanceof Error?error.message:String(error);console.error('[twitter:preparation]',message);try{await post('/api/internal/twitter-circuit-breaker',{workerName,operation:'failure',reason:message});}catch{}process.exitCode=1;}if(once)break;await sleep(interval);}while(!stopping);
