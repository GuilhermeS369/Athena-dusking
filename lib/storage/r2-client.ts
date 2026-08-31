// Import dinâmico do @aws-sdk/*: evita quebrar o carregamento do módulo em
// qualquer ambiente onde essas dependências não estejam instaladas (mesmo
// que o backend 'r2' não esteja em uso) — mesma causa raiz de um crash-loop
// já visto no worker de VPS quando o pacote não estava presente.
let clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

async function r2Client() {
  if (!clientPromise) {
    clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({
      region: 'auto',
      endpoint: requiredEnv('R2_ENDPOINT'),
      credentials: {
        accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
      },
    }));
  }
  return clientPromise;
}

export async function createR2SignedUrl(bucket: string, storagePath: string, expiresInSeconds: number) {
  const [{ GetObjectCommand }, { getSignedUrl }, client] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
    r2Client(),
  ]);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: storagePath }), { expiresIn: expiresInSeconds });
}

export async function uploadToR2(bucket: string, storagePath: string, body: Uint8Array | Buffer, contentType?: string) {
  const [{ PutObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), r2Client()]);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: storagePath,
    Body: body,
    ...(contentType ? { ContentType: contentType } : {}),
  }));
}

export async function objectExistsInR2(bucket: string, storagePath: string) {
  try {
    const [{ HeadObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), r2Client()]);
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storagePath }));
    return true;
  } catch {
    return false;
  }
}

// DeleteObjects aceita no maximo 1000 chaves por chamada e — diferente do
// resto do SDK — nao lanca quando uma chave individual falha: devolve a lista
// em `Errors` com HTTP 200. Ignorar isso era exatamente como um arquivo ficava
// orfao no R2 sem ninguem perceber, entao a falha parcial vira excecao.
const R2_DELETE_BATCH = 1000;

export async function deleteFromR2(bucket: string, storagePaths: string[]) {
  if (!storagePaths.length) return;
  const [{ DeleteObjectsCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), r2Client()]);
  const failures: string[] = [];
  for (let index = 0; index < storagePaths.length; index += R2_DELETE_BATCH) {
    const batch = storagePaths.slice(index, index + R2_DELETE_BATCH);
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })) },
    }));
    for (const failure of result.Errors ?? []) {
      failures.push(`${failure.Key ?? 'chave desconhecida'}: ${failure.Code ?? 'erro'} ${failure.Message ?? ''}`.trim());
    }
  }
  if (failures.length) {
    throw new Error(`O R2 recusou ${failures.length} arquivo(s): ${failures.slice(0, 5).join(' | ')}`);
  }
}

// Presigned PUT: usado para permitir upload direto do navegador para o R2,
// sem o corpo binário do arquivo passar pela função serverless da Vercel.
// ContentType não entra no comando assinado de propósito — assim o navegador
// pode enviar qualquer Content-Type sem invalidar a assinatura.
export async function createR2UploadUrl(bucket: string, storagePath: string, expiresInSeconds: number) {
  const [{ PutObjectCommand }, { getSignedUrl }, client] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
    r2Client(),
  ]);
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: storagePath }), { expiresIn: expiresInSeconds });
}
