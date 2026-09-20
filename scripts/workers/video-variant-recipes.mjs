/**
 * Receitas de variante de video por post (Reels). Modulo PURO: sorteia os
 * parametros e monta os argumentos do ffmpeg. Nao executa nada, nao le disco,
 * nao fala com banco -- quem faz isso e o publication-video-variant-worker.mjs.
 *
 * POR QUE EXISTE. O mesmo arquivo sobe dezenas de vezes por dia em perfis
 * diferentes (19/09/2026: 50.010 reels de 1.512 arquivos, ate 176 posts do mesmo
 * arquivo num dia). Cada post passa a subir um arquivo unico, gerado na VPS de
 * variantes. Ninguem sabe em qual camada o Instagram compara (embrulho, faixa
 * de video comprimida, faixa de audio comprimida, pixels/som), entao ha tres
 * receitas e o teste de desempenho das postagens decide:
 *
 *   container  so o embrulho: marca aleatoria no metadado do MP4. Teste.
 *   micro      PADRAO. Video copiado SEM recodificar + marca unica dentro da
 *              faixa de video (SEI user_data) + audio regravado no mesmo bitrate
 *              com ganho inaudivel e ruido semeado a -90 dB. Pixels identicos.
 *              Medido em 20/09/2026 na VPS de variantes (ffmpeg 8.0.1): ~190 ms
 *              para 15 s de 1080x1920.
 *   light      video recodificado (x264 veryfast, 1 passada) com bitrate
 *              sorteado em +-0,3% e ruido de 1 nivel semeado nos pixels + a mesma
 *              marca SEI; audio copiado. ~8 s por video. Teste.
 *
 * UNICIDADE. Nao depende de quantas vezes o arquivo e postado: cada variante
 * leva uma marca de 122 bits aleatorios (UUID v4) mais uma semente de 32 bits
 * (audio, micro) ou de 31 bits (pixel, light).
 * So o bitrate nao serviria: +-0,3% de 6.000 kbps da ~37 valores inteiros e
 * repetiria no primeiro dia. A prova fica no banco: SHA-256 por variante com
 * indice unico por arquivo de origem (migration 436).
 *
 * O filtro h264_metadata tem sei_user_data; o hevc_metadata NAO tem (conferido
 * no ffmpeg 6.1.1 e no 8.0.1). Fonte que nao e H.264 leva a marca so no
 * metadado do embrulho.
 */

import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export const VIDEO_VARIANT_RECIPES = Object.freeze(['container', 'micro', 'light']);
export const DEFAULT_VIDEO_VARIANT_RECIPE = 'micro';

// -90 dBFS em amplitude linear: 10^(-90/20). Abaixo do piso de ruido de qualquer
// gravacao de celular; existe para a faixa de audio regravada nunca repetir.
const AUDIO_NOISE_AMPLITUDE = 0.0000316;
// Ganho entre 0,05 e 0,15 dB, para cima ou para baixo. Inaudivel (o limiar de
// percepcao fica perto de 1 dB) e suficiente para mudar todas as amostras.
const AUDIO_GAIN_MIN_DB = 0.05;
const AUDIO_GAIN_MAX_DB = 0.15;
// Faixa do sorteio de bitrate da receita light: o que 19 pares de concorrentes
// mostraram em 16/09/2026 (so a compressao do video mudava, em +-0,3%).
const LIGHT_BITRATE_SPREAD = 0.003;
const DEFAULT_AUDIO_BITRATE = 128_000;
const MIN_AUDIO_BITRATE = 48_000;
const MAX_AUDIO_BITRATE = 320_000;
const DEFAULT_VIDEO_BITRATE = 6_000_000;

export function isVideoVariantRecipe(value) {
  return VIDEO_VARIANT_RECIPES.includes(value);
}

function uint32(random) {
  return random.int(0, 0xffffffff);
}

const cryptoRandom = Object.freeze({
  uuid: () => randomUUID(),
  hex: (bytes) => randomBytes(bytes).toString('hex'),
  // randomInt exclui o maximo; +1 para o intervalo ser fechado.
  int: (minimum, maximum) => randomInt(minimum, maximum + 1),
});

/**
 * Sorteia os parametros de UMA variante. O resultado vai inteiro para a coluna
 * recipe_params: com ele e o arquivo de origem a variante e reproduzivel.
 * `random` so existe para o teste injetar valores fixos.
 */
export function drawVideoVariantParams(recipe, random = cryptoRandom) {
  if (!isVideoVariantRecipe(recipe)) {
    throw new Error(`video_variant_recipe_unknown:${recipe}`);
  }
  const params = {
    recipe,
    // 122 bits aleatorios. O h264_metadata quer o UUID sem hifens.
    tag_uuid: random.uuid().replaceAll('-', '').toLowerCase(),
    tag_extra: random.hex(8),
  };
  if (recipe === 'micro') {
    params.audio_seed = uint32(random);
    const magnitude = AUDIO_GAIN_MIN_DB
      + (random.int(0, 10_000) / 10_000) * (AUDIO_GAIN_MAX_DB - AUDIO_GAIN_MIN_DB);
    params.audio_gain_db = Number((random.int(0, 1) === 0 ? -magnitude : magnitude).toFixed(4));
  }
  if (recipe === 'light') {
    // O filtro noise aceita semente ate 2^31-1 (o anoisesrc aceita 32 bits).
    params.pixel_seed = random.int(0, 0x7fffffff);
    params.bitrate_factor = Number(
      (1 - LIGHT_BITRATE_SPREAD + (random.int(0, 10_000) / 10_000) * 2 * LIGHT_BITRATE_SPREAD).toFixed(6),
    );
  }
  return params;
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * Resume o ffprobe da fonte no que as receitas precisam. Aceita o JSON de
 * `ffprobe -show_streams -show_format -of json`.
 */
export function summarizeSourceProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video') ?? null;
  const audio = streams.find((stream) => stream?.codec_type === 'audio') ?? null;
  if (!video) throw new Error('video_variant_source_without_video');
  const [rateNumerator, rateDenominator] = String(video.avg_frame_rate || video.r_frame_rate || '30/1')
    .split('/').map(Number);
  const frameRate = rateDenominator > 0 && rateNumerator > 0 ? rateNumerator / rateDenominator : 30;
  return {
    videoCodec: String(video.codec_name || ''),
    videoBitrate: clampInteger(
      video.bit_rate || probe?.format?.bit_rate, 200_000, 60_000_000, DEFAULT_VIDEO_BITRATE,
    ),
    frameRate,
    hasBFrames: Number(video.has_b_frames) > 0,
    hasAudio: Boolean(audio),
    audioBitrate: clampInteger(audio?.bit_rate, MIN_AUDIO_BITRATE, MAX_AUDIO_BITRATE, DEFAULT_AUDIO_BITRATE),
    audioSampleRate: clampInteger(audio?.sample_rate, 8_000, 96_000, 44_100),
    durationSeconds: Number(probe?.format?.duration) > 0 ? Number(probe.format.duration) : null,
  };
}

function seiTag(params) {
  return `h264_metadata=sei_user_data=${params.tag_uuid}+${params.tag_extra}`;
}

// A marca no metadado do embrulho entra em TODA receita: e de graca e cobre a
// fonte que nao e H.264, onde o SEI nao existe.
function containerTagArgs(params) {
  return ['-map_metadata', '0', '-metadata', `comment=${params.tag_uuid}${params.tag_extra}`];
}

/**
 * Argumentos do ffmpeg (sem o executavel) para gerar UMA variante.
 * `source` vem de summarizeSourceProbe. Sempre termina em `-movflags +faststart`:
 * a Meta recusa MP4 com o `moov` no fim.
 */
export function buildFfmpegArgs({ params, source, inputPath, outputPath }) {
  if (!isVideoVariantRecipe(params?.recipe)) {
    throw new Error(`video_variant_recipe_unknown:${params?.recipe}`);
  }
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath];
  const tail = [...containerTagArgs(params), '-movflags', '+faststart', '-f', 'mp4', outputPath];
  const isH264 = source.videoCodec === 'h264';
  const videoCopy = isH264
    ? ['-c:v', 'copy', '-bsf:v', seiTag(params)]
    : ['-c:v', 'copy'];

  if (params.recipe === 'container') {
    const maps = source.hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0'];
    return [...head, ...maps, '-c', 'copy', ...tail];
  }

  if (params.recipe === 'micro') {
    if (!source.hasAudio) {
      // Sem audio nao ha o que regravar: fica a marca na faixa de video.
      return [...head, '-map', '0:v:0', ...videoCopy, ...tail];
    }
    const noise = `anoisesrc=color=white:amplitude=${AUDIO_NOISE_AMPLITUDE}`
      + `:seed=${params.audio_seed}:sample_rate=${source.audioSampleRate}`;
    // normalize=0: sem isso o amix divide o volume por 2 e a mudanca vira audivel.
    const graph = `[0:a:0]volume=${params.audio_gain_db}dB[a0];`
      + '[a0][1:a]amix=inputs=2:duration=first:normalize=0[a]';
    return [
      ...head,
      '-f', 'lavfi', '-i', noise,
      '-filter_complex', graph,
      '-map', '0:v:0', '-map', '[a]',
      ...videoCopy,
      '-c:a', 'aac', '-b:a', String(source.audioBitrate),
      ...tail,
    ];
  }

  // light: recodifica o video. Estrutura de quadros proxima da fonte (GOP de 2 s,
  // sem corte de cena) para o arquivo continuar com cara do original.
  const bitrate = Math.round(source.videoBitrate * params.bitrate_factor);
  const gop = Math.max(12, Math.round(source.frameRate * 2));
  const x264 = [
    `keyint=${gop}`, `min-keyint=${gop}`, 'scenecut=0',
    `bframes=${source.hasBFrames ? 2 : 0}`, 'b-adapt=0',
  ].join(':');
  const maps = source.hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0'];
  return [
    ...head,
    ...maps,
    // c0s=1: ruido de 1 nivel so na luminancia; all_seed fixa o sorteio.
    '-vf', `noise=c0s=1:c0f=t:all_seed=${params.pixel_seed}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)),
    '-bufsize', String(bitrate * 2),
    '-x264-params', x264,
    '-fps_mode', 'passthrough',
    '-bsf:v', seiTag(params),
    ...(source.hasAudio ? ['-c:a', 'copy'] : []),
    ...tail,
  ];
}

/** Argumentos do ffprobe que alimentam summarizeSourceProbe e a conferencia da saida. */
export function buildFfprobeArgs(filePath) {
  return ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath];
}

/**
 * Confere a saida contra a fonte antes do upload. Devolve o codigo do problema
 * ou null. Variante invalida nunca sobe: a Meta recusaria e o post se perderia.
 */
export function validateVariantProbe({ source, output, params }) {
  let summary;
  try {
    summary = summarizeSourceProbe(output);
  } catch {
    return 'video_variant_output_without_video';
  }
  if (source.hasAudio && !summary.hasAudio) return 'video_variant_output_lost_audio';
  if (params.recipe !== 'light' && summary.videoCodec !== source.videoCodec) {
    return 'video_variant_output_codec_changed';
  }
  if (source.durationSeconds && summary.durationSeconds) {
    // Meio segundo de folga: o AAC regravado arredonda o fim para o quadro de audio.
    if (Math.abs(summary.durationSeconds - source.durationSeconds) > 0.5) {
      return 'video_variant_output_duration_changed';
    }
  }
  return null;
}
