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
 *              padrao, e a Meta aceitou (22/09/2026). So H.264 yuv420p.
 *   bookend_mid a bookend + poucos quadros congelados NO MEIO (3 a 9). O original e
 *              cortado sem recodificar EXATAMENTE num quadro-chave perto do meio e as
 *              duas metades entram por copia. Medido em 23/09/2026 na VPS de variantes
 *              com 4 videos reais (28-46 s, todos com B-frames e quadros-chave IDR a
 *              cada 2-9 s): 2,1-2,9 s por video e as duas metades IDENTICAS a fonte
 *              quadro a quadro, em todos os cortes testados. O teste de 22/09 que
 *              duplicou 9 s errou no TEMPO do corte, nao no corte: passar ao divisor um
 *              tempo um fio acima do quadro-chave faz ele cortar no quadro-chave
 *              SEGUINTE. Por isso o corte vai meio quadro antes do quadro-chave, o
 *              quadro congelado sai da primeira imagem da segunda metade, e o worker
 *              confere a contagem de quadros da primeira metade antes de seguir.
 *
 * NIVEIS NO PAINEL (23/09/2026, decisao do dono): 1 = micro, 2 = bookend (PADRAO),
 * 3 = bookend_mid. `container` e `light` sairam do painel, mas o worker continua
 * sabendo gera-las: variante ja agendada com elas pode voltar para a fila (objeto
 * sumiu do R2) e nao pode virar erro.
 *
 * FONTE QUE NAO DA PARA EMENDAR SEM RECODIFICAR (nao H.264 yuv420p): bookend e
 * bookend_mid saem como micro (`applied_recipe`), em vez de falhar. Com a bookend
 * como padrao, falhar ali tiraria o post da fila.
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

// Tudo que o worker sabe gerar (inclusive as que sairam do painel).
export const VIDEO_VARIANT_RECIPES = Object.freeze(['container', 'micro', 'light', 'bookend', 'bookend_mid']);
// O que o painel oferece, em ordem de nivel. Bate com BULK_VIDEO_VARIANT_RECIPES.
export const OFFERED_VIDEO_VARIANT_RECIPES = Object.freeze(['micro', 'bookend', 'bookend_mid']);
export const DEFAULT_VIDEO_VARIANT_RECIPE = 'bookend';
// Receitas que emendam pedacos novos no original sem recodifica-lo.
const SPLICED_RECIPES = new Set(['bookend', 'bookend_mid']);

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
// bookend_mid: o congelado do meio fica perto do quadro-chave mais proximo de um
// ponto sorteado entre 30% e 70% do video, com pelo menos 1 s de video dos dois lados.
const MID_POSITION_MIN_PCT = 30;
const MID_POSITION_MAX_PCT = 70;
const MID_EDGE_MARGIN_SECONDS = 1;

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
  if (recipe === 'micro' || SPLICED_RECIPES.has(recipe)) {
    params.audio_seed = uint32(random);
    const magnitude = AUDIO_GAIN_MIN_DB
      + (random.int(0, 10_000) / 10_000) * (AUDIO_GAIN_MAX_DB - AUDIO_GAIN_MIN_DB);
    params.audio_gain_db = Number((random.int(0, 1) === 0 ? -magnitude : magnitude).toFixed(4));
  }
  if (SPLICED_RECIPES.has(recipe)) {
    params.freeze_frames = random.int(BOOKEND_FREEZE_MIN_FRAMES, BOOKEND_FREEZE_MAX_FRAMES);
    params.black_seconds = random.int(BOOKEND_BLACK_MIN_TENTHS, BOOKEND_BLACK_MAX_TENTHS) / 10;
  }
  if (recipe === 'bookend_mid') {
    params.mid_freeze_frames = random.int(BOOKEND_FREEZE_MIN_FRAMES, BOOKEND_FREEZE_MAX_FRAMES);
    params.mid_position_pct = random.int(MID_POSITION_MIN_PCT, MID_POSITION_MAX_PCT);
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

/** So a bookend_mid precisa saber onde ficam os quadros-chave da fonte. */
export function recipeNeedsKeyframes(recipe) {
  return recipe === 'bookend_mid';
}

/**
 * Pacotes de video da fonte (tempo e flag), sem decodificar nada: ~0,2 s para um
 * video de 45 s. Alimenta parseKeyframes.
 */
export function buildKeyframeProbeArgs(filePath) {
  return ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', filePath];
}

/**
 * Quadros-chave da fonte em ordem de tela: { seconds, framesBefore }, onde
 * framesBefore e quantos quadros aparecem antes dele -- o tamanho exato da
 * primeira metade quando o corte e ali. Contado sobre os carimbos, nao sobre
 * tempo x taxa: video de taxa irregular erraria a conta.
 */
export function parseKeyframes(csv) {
  const packets = String(csv || '').split(/\r?\n/).flatMap((line) => {
    const [time, flags = ''] = line.split(',');
    const seconds = Number(time);
    return Number.isFinite(seconds) && time.trim() !== '' ? [{ seconds, key: flags.includes('K') }] : [];
  });
  packets.sort((a, b) => a.seconds - b.seconds);
  return packets.flatMap((packet, index) => (packet.key ? [{ seconds: packet.seconds, framesBefore: index }] : []));
}

/** So da para emendar sem recodificar quando a fonte e H.264 yuv420p com resolucao conhecida. */
export function canSplice(source) {
  return source?.videoCodec === 'h264' && source.pixFmt === 'yuv420p' && Boolean(source.width) && Boolean(source.height);
}

/** A receita que de fato sai: a da linha, ou `micro` quando a fonte nao aceita emenda. */
export function appliedRecipe(params) {
  return params?.applied_recipe ?? params?.recipe;
}

/**
 * Quadro-chave onde o congelado do meio entra: o mais perto do ponto sorteado,
 * com pelo menos 1 s de video dos dois lados. Null quando o video nao tem nenhum.
 */
export function chooseMidCut(params, source) {
  const duration = Number(source?.durationSeconds);
  if (!(duration > 0) || !Array.isArray(source?.keyframes)) return null;
  const target = duration * (Number(params.mid_position_pct) / 100);
  let best = null;
  for (const keyframe of source.keyframes) {
    if (keyframe.seconds < MID_EDGE_MARGIN_SECONDS || keyframe.seconds > duration - MID_EDGE_MARGIN_SECONDS) continue;
    if (keyframe.framesBefore < 1) continue;
    if (!best || Math.abs(keyframe.seconds - target) < Math.abs(best.seconds - target)) best = keyframe;
  }
  return best;
}

/** A bookend_mid vira bookend simples (sem o meio), com o motivo gravado nos parametros. */
export function withoutMidFreeze(params, reason) {
  const { mid_cut_seconds: _cut, mid_cut_frame: _frame, ...rest } = params;
  return { ...rest, mid_freeze_frames: 0, mid_skipped: reason };
}

/**
 * Completa os parametros sorteados com o que depende da fonte. Puro: o resultado
 * vai inteiro para recipe_params e, com a fonte, reproduz a variante.
 */
export function resolveVariantParams(params, source) {
  if (SPLICED_RECIPES.has(params.recipe) && !canSplice(source)) {
    return { ...params, applied_recipe: 'micro' };
  }
  if (params.recipe !== 'bookend_mid') return { ...params };
  const cut = chooseMidCut(params, source);
  if (!cut) return withoutMidFreeze(params, 'sem_quadro_chave_no_meio');
  return { ...params, mid_cut_seconds: cut.seconds, mid_cut_frame: cut.framesBefore };
}

function hasMidFreeze(params) {
  return params.recipe === 'bookend_mid' && params.mid_freeze_frames > 0 && Number.isFinite(params.mid_cut_seconds);
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
  const recipe = appliedRecipe(params);
  if (SPLICED_RECIPES.has(recipe)) {
    throw new Error(`${recipe} tem varios passos: use buildVariantSteps`);
  }
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath];
  const tail = [...containerTagArgs(params), '-movflags', '+faststart', '-f', 'mp4', outputPath];
  const isH264 = source.videoCodec === 'h264';
  const videoCopy = isH264
    ? ['-c:v', 'copy', '-bsf:v', seiTag(params)]
    : ['-c:v', 'copy'];

  if (recipe === 'container') {
    const maps = source.hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0'];
    return [...head, ...maps, '-c', 'copy', ...tail];
  }

  if (recipe === 'micro') {
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

/** Quanto a variante emendada (bookend, bookend_mid) fica mais longa que a fonte, em segundos. */
export function bookendExtraSeconds(params, source) {
  const middle = hasMidFreeze(params) ? params.mid_freeze_frames : 0;
  return (params.freeze_frames + middle + bookendBlackFrames(params, source)) / source.nominalFps;
}

function x264Profile(profile) {
  const value = String(profile || '').toLowerCase();
  if (value.includes('baseline')) return 'baseline';
  if (value === 'main') return 'main';
  return 'high';
}

/**
 * Os passos para gerar UMA variante. Receita de um passo so (container, micro,
 * light) vira um ffmpeg; bookend e bookend_mid montam pedacos e juntam sem
 * recodificar o original. Tipos de passo:
 *   ffmpeg          roda o ffmpeg com `args`;
 *   file            grava `content` em `path` (a lista do concat);
 *   expect_frames   o arquivo `path` tem de ter exatamente `frames` quadros --
 *                   o worker confere antes de seguir e, se divergir, refaz sem o
 *                   congelado do meio (withoutMidFreeze).
 * `params` ja passou por resolveVariantParams. Tudo que for intermediario vai
 * para `workDir`, que o worker apaga no fim.
 */
export function buildVariantSteps({ params, source, inputPath, outputPath, workDir }) {
  if (!SPLICED_RECIPES.has(appliedRecipe(params))) {
    return [{ kind: 'ffmpeg', args: buildFfmpegArgs({ params, source, inputPath, outputPath }) }];
  }
  if (!canSplice(source)) {
    throw new Error('video_variant_source_unsupported');
  }
  const middleFreeze = hasMidFreeze(params);
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
  ];
  let pieces;
  if (!middleFreeze) {
    steps.push({ kind: 'ffmpeg', args: [...quiet, '-i', inputPath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-video_track_timescale', String(source.timeScale), join('middle.mp4')] });
    pieces = ['freeze.mp4', 'middle.mp4', 'black.mp4'];
  } else {
    // Corte SEM recodificar, no quadro-chave escolhido. O divisor corta no primeiro
    // quadro-chave >= o tempo pedido: pedir meio quadro ANTES garante que seja este,
    // e nao o seguinte (o erro do teste de 22/09, que duplicou 9 s).
    const splitAt = (params.mid_cut_seconds - 0.5 / source.nominalFps).toFixed(6);
    steps.push(
      { kind: 'ffmpeg', args: [...quiet, '-i', inputPath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'segment', '-segment_times', splitAt, '-reset_timestamps', '1', '-segment_format', 'mp4', '-segment_format_options', `video_track_timescale=${source.timeScale}`, join('part%d.mp4')] },
      { kind: 'expect_frames', path: join('part0.mp4'), frames: params.mid_cut_frame },
      // O quadro congelado e a PRIMEIRA imagem da segunda metade: nunca diverge do corte.
      { kind: 'ffmpeg', args: [...quiet, '-i', join('part1.mp4'), '-map', '0:v:0', '-frames:v', '1', '-update', '1', join('mid.png')] },
      { kind: 'ffmpeg', args: [...quiet, '-loop', '1', '-i', join('mid.png'), '-frames:v', String(params.mid_freeze_frames), ...piece, join('midfreeze.mp4')] },
    );
    pieces = ['freeze.mp4', 'part0.mp4', 'midfreeze.mp4', 'part1.mp4', 'black.mp4'];
  }
  steps.push(
    { kind: 'file', path: join('list.txt'), content: pieces.map((name) => `file '${join(name)}'`).join('\n') + '\n' },
    { kind: 'ffmpeg', args: [...quiet, '-f', 'concat', '-safe', '0', '-i', join('list.txt'), '-c', 'copy', join('joined.mp4')] },
  );
  const tail = ['-map_metadata', '1', '-metadata', `comment=${params.tag_uuid}${params.tag_extra}`, '-movflags', '+faststart', '-f', 'mp4', outputPath];
  const videoOut = ['-c:v', 'copy', '-bsf:v', seiTag(params)];
  if (!source.hasAudio) {
    steps.push({ kind: 'ffmpeg', args: [...quiet, '-i', join('joined.mp4'), '-i', inputPath, '-map', '0:v:0', ...videoOut, ...tail] });
    return steps;
  }
  const noise = `anoisesrc=color=white:amplitude=${AUDIO_NOISE_AMPLITUDE}`
    + `:seed=${params.audio_seed}:sample_rate=${source.audioSampleRate}`;
  // Mesma regravacao da micro, atrasada pelos quadros congelados e completada com
  // silencio pela tela preta, para o som continuar sincronizado com a imagem. Na
  // bookend_mid o som tambem para durante o congelado do meio: corta no mesmo
  // quadro-chave e completa a primeira parte com silencio (apad mantem o formato).
  let graph;
  if (!middleFreeze) {
    graph = `[1:a:0]volume=${params.audio_gain_db}dB,adelay=${freezeMs}:all=1,apad=pad_dur=${blackSeconds}[a0];`
      + '[a0][2:a]amix=inputs=2:duration=first:normalize=0[a]';
  } else {
    const cut = params.mid_cut_seconds.toFixed(6);
    const middleSeconds = (params.mid_freeze_frames / source.nominalFps).toFixed(4);
    graph = `[1:a:0]volume=${params.audio_gain_db}dB,asplit[x][y];`
      + `[x]atrim=0:${cut},asetpts=PTS-STARTPTS,apad=pad_dur=${middleSeconds}[a1];`
      + `[y]atrim=${cut},asetpts=PTS-STARTPTS[a2];`
      + `[a1][a2]concat=n=2:v=0:a=1,adelay=${freezeMs}:all=1,apad=pad_dur=${blackSeconds}[a0];`
      + '[a0][2:a]amix=inputs=2:duration=first:normalize=0[a]';
  }
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
  const recipe = appliedRecipe(params);
  if (source.hasAudio && !summary.hasAudio) return 'video_variant_output_lost_audio';
  if (recipe !== 'light' && summary.videoCodec !== source.videoCodec) {
    return 'video_variant_output_codec_changed';
  }
  if (source.durationSeconds && summary.durationSeconds) {
    // As emendadas ficam mais longas de proposito (congelados + preto).
    const expected = source.durationSeconds + (SPLICED_RECIPES.has(recipe) ? bookendExtraSeconds(params, source) : 0);
    // Meio segundo de folga: o AAC regravado arredonda o fim para o quadro de audio.
    if (Math.abs(summary.durationSeconds - expected) > 0.5) {
      return 'video_variant_output_duration_changed';
    }
  }
  return null;
}
