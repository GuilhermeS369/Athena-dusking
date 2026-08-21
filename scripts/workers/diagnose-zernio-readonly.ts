import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

const dotenvPath = resolve(process.cwd(), '.env.local');
const fs = require('fs');

if (fs.existsSync(dotenvPath)) {
  const envConfig = fs.readFileSync(dotenvPath, 'utf8');
  envConfig.split('\n').forEach((line: string) => {
    const match = line.match(/^([^#\s][^=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  });
}
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Variáveis de ambiente do Supabase não encontradas.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log('=== INVESTIGAÇÃO ZERNIO (SOMENTE LEITURA) ===');
  
  // 1. Buscar as 5 últimas conexões da Zernio (esquema pode ser diferente)
  console.log('\n--- Últimas conexões Zernio ---');
  const { data: connections, error: connError } = await supabase
    .from('zernio_connections')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
    
  if (connError) {
    console.error('Erro ao buscar conexões:', connError);
  } else {
    console.log(JSON.stringify(connections, null, 2));
  }

  // 2. Buscar logs recentes da Zernio na tabela accounts (que são as contas da zernio no supabase)
  console.log('\n--- Buscando accounts Zernio ---');
  const { data: accounts, error: accError } = await supabase
    .from('social_accounts')
    .select('*')
    .eq('provider', 'zernio')
    .order('created_at', { ascending: false })
    .limit(5);
    
  if (accError) {
    console.log('Tabela social_accounts não encontrada ou erro:', accError.message);
  } else {
    console.log(JSON.stringify(accounts, null, 2));
  }
  
  // 3. Buscar perfis das conexões específicas mencionadas usando nomes diferentes ou tabelas diferentes
  console.log('\n--- Buscando perfis (profiles) ---');
  const { data: specificProfiles, error: pError } = await supabase
    .from('instagram_profiles')
    .select('*')
    .in('username', ['AnastacioTawes66395', 'AnonaSynowiec695965'])
    .limit(5);
    
  if (pError) {
    console.log('Erro ao buscar instagram_profiles:', pError.message);
    // Tenta outra tabela
    const { data: otherProfiles, error: opError } = await supabase
      .from('social_profiles')
      .select('*')
      .in('username', ['AnastacioTawes66395', 'AnonaSynowiec695965']);
    if (opError) {
        console.log('Erro ao buscar social_profiles:', opError.message);
    } else {
        console.log('Encontrado em social_profiles:', JSON.stringify(otherProfiles, null, 2));
    }
  } else {
    console.log('Encontrado em instagram_profiles:', JSON.stringify(specificProfiles, null, 2));
  }

  // 4. Analisar turnos do oauth recém criados
  console.log('\n--- Filas e Turnos OAuth ---');
  const { data: turns, error: turnError } = await supabase
    .from('zernio_oauth_turns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
    
  if (turnError) {
    console.log('Tabela zernio_oauth_turns não encontrada ou erro:', turnError.message);
  } else {
    console.log(JSON.stringify(turns, null, 2));
  }

  // 5. Analisar a divergência de State (callback payload)
  console.log('\n--- Analisando falha no callback_failed ---');
  const { data: callbackAttempts, error: aError } = await supabase
    .from('zernio_connection_intents')
    .select('*')
    .eq('status', 'failed')
    .ilike('diagnostic->>error', '%state%')
    .order('created_at', { ascending: false })
    .limit(3);
    
  if (aError) {
    console.log('Tabela zernio_connection_intents não encontrada ou erro na busca do diagnostic:', aError.message);
  } else {
    const safeAttempts = callbackAttempts?.map((a: any) => ({
      id: a.id,
      state_hash_prefix: a.state_hash ? a.state_hash.substring(0, 10) + '...' : null,
      result_payload: a.result_payload ? 'Presente, extraindo keys: ' + Object.keys(a.result_payload).join(', ') : null,
      diagnostic: a.diagnostic,
      error_message: a.error_message,
      terminal_reason: a.terminal_reason
    }));
    console.log(JSON.stringify(safeAttempts, null, 2));
    
  }

  console.log('\n--- Tentando bater no endpoint de Accounts da Zernio Remota para Jenna e Verdell ---');
  
  try {
    const crypto = require('crypto');
    const ALGORITHM = 'aes-256-gcm';
    // O nome da variável de ambiente é ZERNIO_ENCRYPTION_KEY no nosso repositório
    const RAW_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
    
    if (RAW_ENCRYPTION_KEY && connections && connections.length >= 2) {
       const keyBuf = Buffer.from(RAW_ENCRYPTION_KEY, 'base64');
       
       for (const conn of connections.slice(0, 2)) {
         if (!conn.encrypted_api_key) continue;
         
         const parts = conn.encrypted_api_key.split('.');
         if (parts.length === 4 && parts[0] === 'v1') {
            const iv = Buffer.from(parts[1], 'base64url');
            const authTag = Buffer.from(parts[2], 'base64url');
            const ciphertext = Buffer.from(parts[3], 'base64url');
            
            const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
            decipher.setAuthTag(authTag);
            
            let decrypted = decipher.update(ciphertext);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            const apiKey = decrypted.toString('utf8');
            
            console.log(`\n--- Fetching /v1/accounts for label ${conn.label} ---`);
            const res = await fetch('https://api.zernio.com/v1/accounts', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            
            if (res.ok) {
                const zernioAccounts = await res.json();
                console.log(`Success! Found ${zernioAccounts.data?.length || 0} accounts in this Zernio API key.`);
                console.log(JSON.stringify(zernioAccounts, null, 2));
            } else {
                console.log(`Failed with status: ${res.status}`);
            }
         }
       }
    } else {
       console.log('ZERNIO_API_KEYS_SECRET missing or no connections to decrypt.');
    }
  } catch (err) {
      console.error('Failed to decrypt or fetch from Zernio:', err);
  }
  
  console.log('\nFinalizado script de diagnóstico.');
}

run().catch(console.error);