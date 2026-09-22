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
 *   bookend    poucos quadros congelados NO INICIO (3 a 9 do primeiro quadro) +
 *              tela preta NO FIM (0,5 a 2 s), sem recodificar o video: so os dois
 *              pedacos novos sao codificados e o original entra por copia (concat
 *              demuxer). Audio como na micro, atrasado e completado com silencio.
 *              Medido em 22/09/2026 na VPS de variantes com 3 videos full HD de
 *              43-52 s: ~1-2 s por video, trecho original IDENTICO a fonte quadro a
 *              quadro, zero aviso de decodificacao. O MP4 sai com 2 descricoes de
 *              video no cabecalho (a dos pedacos x264 e a do original): valido pelo
 *              padrao, e o teste e justamente se a Meta aceita. So H.264 yuv420p.
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

export const VIDEO_VARIANT_RECIPES = Object.freeze(['container', 'micro', 'light', 'bookend']);
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
// bookend: "poucos quadros" congelados no inicio (0,1 a 0,3 s a 30 fps) e a tela
// preta no fim variando em decimos de segundo.
const BOOKEND_FREEZE_MIN_FRAMES = 3;
const BOOKEND_FREEZE_MAX_FRAMES = 9;
const BOOKEND_BLACK_MIN_TENTHS = 5;
const BOOKEND_BLACK_MAX_TENTHS = 20;

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
  if (recipe === 'micro' || recipe === 'bookend') {
    params.audio_seed = uint32(random);
    const magnitude = AUDIO_GAIN_MIN_DB
      + (random.int(0, 10_000) / 10_000) * (AUDIO_GAIN_MAX_DB - AUDIO_GAIN_MIN_DB);
    params.audio_gain_db = Number((random.int(0, 1) === 0 ? -magnitude : magnitude).toFixed(4));
  }
  if (recipe === 'bookend') {
    params.freeze_frames = random.int(BOOKEND_FREEZE_MIN_FRAMES, BOOKEND_FREEZE_MAX_FRAMES);
    params.black_seconds = random.int(BOOKEND_BLACK_MIN_TENTHS, BOOKEND_BLACK_MAX_TENTHS) / 10;
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
  // r_frame_rate (a taxa "nominal") e o que os pedacos novos usam: com a media de
  // um video de taxa irregular (ex.: 12870/433) a emenda sai com carimbo repetido.
  const nominalRate = /^\d+\/\d+$/.test(String(video.r_frame_rate || '')) ? String(video.r_frame_rate) : '30/1';
  const [nominalNumerator, nominalDenominator] = nominalRate.split('/').map(Number);
  const timeBase = String(video.time_base || '1/15360').split('/').map(Number);
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
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    pixFmt: String(video.pix_fmt || ''),
    profile: String(video.profile || ''),
    level: Number(video.level) > 0 ? Number(video.level) : null,
    nominalFrameRate: nominalRate,
    nominalFps: nominalDenominator > 0 && nominalNumerator > 0 ? nominalNumerator / nominalDenominator : 30,
    timeScale: timeBase[1] > 0 ? timeBase[1] : 15360,
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
  if (params.recipe === 'bookend') {
    throw new Error('bookend tem varios passos: use buildVariantSteps');
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

function bookendBlackFrames(params, source) {
  return Math.max(1, Math.round(params.black_seconds * source.nominalFps));
}

/** Quanto a variante bookend fica mais longa que a fonte, em segundos. */
export function bookendExtraSeconds(params, source) {
  return (params.freeze_frames + bookendBlackFrames(params, source)) / source.nominalFps;
}

function x264Profile(profile) {
  const value = String(profile || '').toLowerCase();
  if (value.includes('baseline')) return 'baseline';
  if (value === 'main') return 'main';
  return 'high';
}

/**
 * Os passos para gerar UMA variante. Receita de um passo so (container, micro,
 * light) vira um ffmpeg; a bookend monta pedacos e junta sem recodificar o
 * original. Passo `file` grava um arquivo de texto (a lista do concat).
 * Tudo que for intermediario vai para `workDir`, que o worker apaga no fim.
 */
export function buildVariantSteps({ params, source, inputPath, outputPath, workDir }) {
  if (params?.recipe !== 'bookend') {
    return [{ kind: 'ffmpeg', args: buildFfmpegArgs({ params, source, inputPath, outputPath }) }];
  }
  if (source.videoCodec !== 'h264' || source.pixFmt !== 'yuv420p' || !source.width || !source.height) {
    throw new Error('video_variant_source_unsupported');
  }
  const join = (name) => `${workDir}/${name}`;
  const quiet = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  // Pedacos novos: mesma resolucao, taxa nominal, escala de tempo e perfil da
  // fonte; sem B-frames, para o carimbo de tempo nao cruzar a emenda.
  const piece = [
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-profile:v', x264Profile(source.profile),
    ...(source.level ? ['-level', (source.level / 10).toFixed(1)] : []),
    '-bf', '0', '-g', '9999', '-r', source.nominalFrameRate,
    '-video_track_timescale', String(source.timeScale),
  ];
  const blackFrames = bookendBlackFrames(params, source);
  const freezeMs = Math.round((params.freeze_frames / source.nominalFps) * 1000);
  const blackSeconds = (blackFrames / source.nominalFps).toFixed(4);
  const steps = [
    { kind: 'ffmpeg', args: [...quiet, '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-update', '1', join('first.png')] },
    { kind: 'ffmpeg', args: [...quiet, '-loop', '1', '-i', join('first.png'), '-frames:v', String(params.freeze_frames), ...piece, join('freeze.mp4')] },
    { kind: 'ffmpeg', args: [...quiet, '-f', 'lavfi', '-i', `color=black:s=${source.width}x${source.height}:r=${source.nominalFrameRate}`, '-frames:v', String(blackFrames), ...piece, join('black.mp4')] },
    { kind: 'ffmpeg', args: [...quiet, '-i', inputPath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-video_track_timescale', String(source.timeScale), join('middle.mp4')] },
    { kind: 'file', path: join('list.txt'), content: ['freeze.mp4', 'middle.mp4', 'black.mp4'].map((name) => `file '${join(name)}'`).join('\n') + '\n' },
    { kind: 'ffmpeg', args: [...quiet, '-f', 'concat', '-safe', '0', '-i', join('list.txt'), '-c', 'copy', join('joined.mp4')] },
  ];
  const tail = ['-map_metadata', '1', '-metadata', `comment=${params.tag_uuid}${params.tag_extra}`, '-movflags', '+faststart', '-f', 'mp4', outputPath];
  const videoOut = ['-c:v', 'copy', '-bsf:v', seiTag(params)];
  if (!source.hasAudio) {
    steps.push({ kind: 'ffmpeg', args: [...quiet, '-i', join('joined.mp4'), '-i', inputPath, '-map', '0:v:0', ...videoOut, ...tail] });
    return steps;
  }
  const noise = `anoisesrc=color=white:amplitude=${AUDIO_NOISE_AMPLITUDE}`
    + `:seed=${params.audio_seed}:sample_rate=${source.audioSampleRate}`;
  // Mesma regravacao da micro, atrasada pelos quadros congelados e completada com
  // silencio pela tela preta, para o som continuar sincronizado com a imagem.
  const graph = `[1:a:0]volume=${params.audio_gain_db}dB,adelay=${freezeMs}:all=1,apad=pad_dur=${blackSeconds}[a0];`
    + '[a0][2:a]amix=inputs=2:duration=first:normalize=0[a]';
  steps.push({
    kind: 'ffmpeg',
    args: [
      ...quiet, '-i', join('joined.mp4'), '-i', inputPath, '-f', 'lavfi', '-i', noise,
      '-filter_complex', graph, '-map', '0:v:0', '-map', '[a]',
      ...videoOut, '-c:a', 'aac', '-b:a', String(source.audioBitrate),
      ...tail,
    ],
  });
  return steps;
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
    // A bookend fica mais longa de proposito (congelados + preto).
    const expected = source.durationSeconds + (params.recipe === 'bookend' ? bookendExtraSeconds(params, source) : 0);
    // Meio segundo de folga: o AAC regravado arredonda o fim para o quadro de audio.
    if (Math.abs(summary.durationSeconds - expected) > 0.5) {
      return 'video_variant_output_duration_changed';
    }
  }
  return null;
}
