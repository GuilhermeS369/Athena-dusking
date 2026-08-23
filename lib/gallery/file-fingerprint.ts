const singleDigestLimit = 64 * 1024 * 1024;
const chunkSize = 8 * 1024 * 1024;

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Mantém SHA-256 integral para arquivos comuns e usa uma árvore por blocos nos grandes. */
export async function fingerprintMediaFile(
  file: Pick<File, "arrayBuffer" | "size" | "slice">,
) {
  if (file.size <= singleDigestLimit) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    return hex(new Uint8Array(digest));
  }
  const chunkDigests: Uint8Array[] = [];
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", chunk);
    chunkDigests.push(new Uint8Array(digest));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  const header = new TextEncoder().encode(
    `twitter-gallery-tree-sha256-v1:${file.size}:${chunkDigests.length}:`,
  );
  const tree = new Uint8Array(header.length + chunkDigests.length * 32);
  tree.set(header, 0);
  chunkDigests.forEach((digest, index) =>
    tree.set(digest, header.length + index * 32),
  );
  const root = await crypto.subtle.digest("SHA-256", tree);
  return hex(new Uint8Array(root));
}
