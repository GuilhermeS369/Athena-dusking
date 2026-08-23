const MAX_THUMBNAIL_WIDTH = 960;
const JPEG_QUALITY = 0.82;
const VIDEO_METADATA_TIMEOUT_MS = 12_000;
const VIDEO_SEEK_TIMEOUT_MS = 8_000;

type Frame = { file: File; brightness: number; contrast: number };

function videoReadError(video: HTMLVideoElement) {
  const code = video.error?.code;
  const reason =
    code === MediaError.MEDIA_ERR_ABORTED
      ? "leitura cancelada"
      : code === MediaError.MEDIA_ERR_NETWORK
        ? "falha de leitura do arquivo"
        : code === MediaError.MEDIA_ERR_DECODE
          ? "codec ou arquivo não pôde ser decodificado"
          : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? "formato ou codec não suportado pelo navegador"
            : "erro desconhecido do navegador";
  return new Error(
    `Não foi possível ler os quadros deste vídeo (${reason}${video.error?.message ? `: ${video.error.message}` : ""}).`,
  );
}

function waitFor(
  video: HTMLVideoElement,
  event: "loadedmetadata" | "seeked",
  timeoutMs = VIDEO_SEEK_TIMEOUT_MS,
  isAlreadyReady: () => boolean = () => false,
) {
  return new Promise<void>((resolve, reject) => {
    if (isAlreadyReady()) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => {
      cleanup();
      // Alguns navegadores atualizam readyState/currentTime em blobs locais sem
      // despachar o evento correspondente. O estado é a fonte de verdade.
      if (isAlreadyReady()) resolve();
      else
        reject(
          new Error(
            `Tempo esgotado ao preparar a miniatura do vídeo (${event}; readyState=${video.readyState}, networkState=${video.networkState}).`,
          ),
        );
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onSuccess);
      video.removeEventListener("seeked", onSuccess);
      video.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(videoReadError(video));
    };
    video.addEventListener(event, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(
              new Error(
                "O navegador não conseguiu criar a imagem da miniatura.",
              ),
            ),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

export async function createVideoFallbackThumbnail(fileName: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas indisponível neste navegador.");
  context.fillStyle = "#111827";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#34d399";
  context.beginPath();
  context.moveTo(292, 132);
  context.lineTo(292, 228);
  context.lineTo(380, 180);
  context.closePath();
  context.fill();
  context.fillStyle = "#d1fae5";
  context.font = "bold 28px sans-serif";
  context.textAlign = "center";
  context.fillText("Vídeo", canvas.width / 2, 286);
  const blob = await canvasToBlob(canvas);
  return new File([blob], `${fileName.replace(/\.[^.]+$/, "")}-thumb.jpg`, {
    type: "image/jpeg",
  });
}

export async function createGifThumbnail(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const width = Math.min(bitmap.width, MAX_THUMBNAIL_WIDTH);
    const height = Math.max(
      1,
      Math.round(bitmap.height * (width / bitmap.width)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas indisponível neste navegador.");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}-thumb.jpg`, {
      type: "image/jpeg",
    });
  } finally {
    bitmap.close();
  }
}

function evaluateFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const sampleWidth = Math.min(64, width);
  const sampleHeight = Math.max(1, Math.round(height * (sampleWidth / width)));
  const sample = document.createElement("canvas");
  sample.width = sampleWidth;
  sample.height = sampleHeight;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) return { brightness: 0, contrast: 0 };
  sampleContext.drawImage(context.canvas, 0, 0, sampleWidth, sampleHeight);
  const data = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let total = 0;
  let totalSquared = 0;
  for (let index = 0; index < data.length; index += 4) {
    const luminance =
      0.2126 * data[index] +
      0.7152 * data[index + 1] +
      0.0722 * data[index + 2];
    total += luminance;
    totalSquared += luminance * luminance;
  }
  const count = data.length / 4;
  const brightness = total / count;
  return {
    brightness,
    contrast: Math.sqrt(
      Math.max(0, totalSquared / count - brightness * brightness),
    ),
  };
}

async function captureFrame(
  video: HTMLVideoElement,
  time: number,
  fileName: string,
): Promise<Frame> {
  // O listener precisa existir antes de alterar currentTime. Em blobs pequenos,
  // Chromium/WebKit podem concluir o seek antes da próxima microtask; o código
  // anterior perdia o evento e aguardava inutilmente até o timeout.
  const seeked = waitFor(
    video,
    "seeked",
    VIDEO_SEEK_TIMEOUT_MS,
    () =>
      !video.seeking &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      Math.abs(video.currentTime - time) < 0.08,
  );
  video.currentTime = time;
  await seeked;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight)
    throw new Error("O vídeo não possui dimensões utilizáveis.");
  const width = Math.min(sourceWidth, MAX_THUMBNAIL_WIDTH);
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas indisponível neste navegador.");
  context.drawImage(video, 0, 0, width, height);
  const metrics = evaluateFrame(context, width, height);
  const blob = await canvasToBlob(canvas);
  return {
    file: new File([blob], `${fileName.replace(/\.[^.]+$/, "")}-thumb.jpg`, {
      type: "image/jpeg",
    }),
    ...metrics,
  };
}

/**
 * Captura no segundo 1 e tenta posições alternativas quando a imagem é quase
 * preta ou muito uniforme (abertura/fade). Não envia o vídeo a nenhum serviço.
 */
export async function createRealVideoThumbnail(file: File) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  try {
    // Registra a espera antes de atribuir o blob. Para arquivos MP4 pequenos, o
    // evento loadedmetadata pode ocorrer imediatamente durante a atribuição de
    // src e era perdido pelo fluxo anterior, embora H.264/AAC fosse compatível.
    const metadata = waitFor(
      video,
      "loadedmetadata",
      VIDEO_METADATA_TIMEOUT_MS,
      () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
    );
    video.src = url;
    video.load();
    await metadata;
    if (!Number.isFinite(video.duration) || video.duration <= 0)
      throw new Error("A duração do vídeo não pôde ser determinada.");
    const duration = video.duration;
    const candidates = [
      ...new Set([
        Math.min(1, Math.max(0.05, duration * 0.1)),
        Math.min(Math.max(0.1, duration * 0.12), Math.max(0.1, duration - 0.1)),
        Math.min(Math.max(0.1, duration * 0.35), Math.max(0.1, duration - 0.1)),
      ]),
    ];
    const frames: Frame[] = [];
    for (const candidate of candidates) {
      try {
        frames.push(await captureFrame(video, candidate, file.name));
      } catch {
        /* tenta o próximo ponto */
      }
    }
    if (!frames.length)
      throw new Error("Nenhum quadro do vídeo pôde ser capturado.");
    const usable = frames.filter(
      (frame) => frame.brightness > 12 && frame.contrast > 5,
    );
    return (usable.length ? usable : frames).sort(
      (left, right) =>
        right.contrast +
        right.brightness * 0.1 -
        (left.contrast + left.brightness * 0.1),
    )[0].file;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function createVideoThumbnail(file: File) {
  try {
    return await createRealVideoThumbnail(file);
  } catch (error) {
    console.warn(
      "[gallery] Não foi possível capturar quadro do vídeo; usando miniatura fallback.",
      error,
    );
    return createVideoFallbackThumbnail(file.name);
  }
}
