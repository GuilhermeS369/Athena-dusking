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
