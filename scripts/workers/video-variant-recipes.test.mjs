import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  DEFAULT_VIDEO_VARIANT_RECIPE,
  OFFERED_VIDEO_VARIANT_RECIPES,
  VIDEO_VARIANT_RECIPES,
  appliedRecipe,
  buildFfmpegArgs,
  buildFfprobeArgs,
  buildKeyframeProbeArgs,
  buildVariantSteps,
  bookendExtraSeconds,
  chooseMidCut,
  drawVideoVariantParams,
  isVideoVariantRecipe,
  parseKeyframes,
  recipeNeedsKeyframes,
  resolveVariantParams,
  summarizeSourceProbe,
  validateVariantProbe,
  withoutMidFreeze,
} from './video-variant-recipes.mjs';

const run = promisify(execFile);

const h264Source = Object.freeze({
  videoCodec: 'h264',
  videoBitrate: 6_000_000,
  frameRate: 30,
  hasBFrames: true,
  hasAudio: true,
  audioBitrate: 128_000,
  audioSampleRate: 44_100,
  durationSeconds: 15,
  width: 1080,
  height: 1920,
  pixFmt: 'yuv420p',
  profile: 'High',
  level: 40,
  nominalFrameRate: '30/1',
  nominalFps: 30,
  timeScale: 15360,
});

// Receitas de um passo so (as emendadas tem varios e usam buildVariantSteps).
const SPLICED = ['bookend', 'bookend_mid'];
const SINGLE_STEP_RECIPES = VIDEO_VARIANT_RECIPES.filter((recipe) => !SPLICED.includes(recipe));

// Quadros-chave a cada 3 s num video de 15 s a 30 fps (framesBefore = segundos x 30).
const withKeyframes = (source = h264Source) => ({
  ...source,
  keyframes: [0, 3, 6, 9, 12].map((seconds) => ({ seconds, framesBefore: seconds * 30 })),
});

function argsFor(recipe, source = h264Source) {
  const params = drawVideoVariantParams(recipe);
  return { params, args: buildFfmpegArgs({ params, source, inputPath: 'in.mp4', outputPath: 'out.mp4' }) };
}

test('niveis do painel: 1 micro, 2 bookend (padrao), 3 bookend_mid; container e light so no worker', () => {
  assert.equal(DEFAULT_VIDEO_VARIANT_RECIPE, 'bookend');
  assert.deepEqual([...OFFERED_VIDEO_VARIANT_RECIPES], ['micro', 'bookend', 'bookend_mid']);
  assert.deepEqual([...VIDEO_VARIANT_RECIPES], ['container', 'micro', 'light', 'bookend', 'bookend_mid']);
  for (const recipe of OFFERED_VIDEO_VARIANT_RECIPES) assert.ok(isVideoVariantRecipe(recipe), recipe);
  assert.equal(isVideoVariantRecipe('visible'), false);
  assert.throws(() => drawVideoVariantParams('visible'), /video_variant_recipe_unknown/);
});

test('cada sorteio e unico: marca de 122 bits e sementes de 32 bits', () => {
  const tags = new Set();
  for (let index = 0; index < 2_000; index += 1) {
    const params = drawVideoVariantParams('micro');
    assert.match(params.tag_uuid, /^[0-9a-f]{32}$/);
    assert.match(params.tag_extra, /^[0-9a-f]{16}$/);
    assert.ok(Number.isInteger(params.audio_seed) && params.audio_seed >= 0 && params.audio_seed <= 0xffffffff);
    assert.ok(Math.abs(params.audio_gain_db) >= 0.05 && Math.abs(params.audio_gain_db) <= 0.15);
    tags.add(params.tag_uuid);
  }
  assert.equal(tags.size, 2_000);
});

test('light sorteia o bitrate em +-0,3% e leva semente de pixel', () => {
  for (let index = 0; index < 500; index += 1) {
    const params = drawVideoVariantParams('light');
    assert.ok(params.bitrate_factor >= 0.997 && params.bitrate_factor <= 1.003);
    assert.ok(Number.isInteger(params.pixel_seed));
    assert.equal(params.audio_seed, undefined);
  }
});

test('micro copia o video, marca a faixa e regrava o audio no bitrate da fonte', () => {
  const { params, args } = argsFor('micro');
  const line = args.join(' ');
  assert.ok(line.includes('-c:v copy'));
  assert.ok(line.includes(`-bsf:v h264_metadata=sei_user_data=${params.tag_uuid}+${params.tag_extra}`));
  assert.ok(line.includes(`seed=${params.audio_seed}`));
  assert.ok(line.includes('normalize=0'));
  assert.ok(line.includes('-c:a aac -b:a 128000'));
  assert.ok(!line.includes('libx264'));
});

test('toda receita poe o moov na frente e marca o embrulho', () => {
  for (const recipe of SINGLE_STEP_RECIPES) {
    const { params, args } = argsFor(recipe);
    const line = args.join(' ');
    assert.ok(line.includes('-movflags +faststart'), recipe);
    assert.ok(line.includes(`comment=${params.tag_uuid}${params.tag_extra}`), recipe);
    assert.equal(args.at(-1), 'out.mp4');
  }
});

test('container nao recodifica nada', () => {
  const { args } = argsFor('container');
  const line = args.join(' ');
  assert.ok(line.includes('-c copy'));
  assert.ok(!line.includes('aac'));
  assert.ok(!line.includes('h264_metadata'));
});

test('fonte que nao e H.264 nao recebe o filtro de SEI (hevc_metadata nao tem sei_user_data)', () => {
  const { args } = argsFor('micro', { ...h264Source, videoCodec: 'hevc' });
  assert.ok(!args.join(' ').includes('h264_metadata'));
  assert.ok(args.join(' ').includes('-c:a aac'));
});

test('micro sem audio fica so com a marca na faixa de video', () => {
  const { args } = argsFor('micro', { ...h264Source, hasAudio: false });
  const line = args.join(' ');
  assert.ok(line.includes('h264_metadata=sei_user_data='));
  assert.ok(!line.includes('anoisesrc'));
  assert.ok(!line.includes('-c:a'));
});

test('light recodifica com semente de pixel, marca SEI e copia o audio', () => {
  const { params, args } = argsFor('light');
  const line = args.join(' ');
  assert.ok(line.includes(`all_seed=${params.pixel_seed}`));
  assert.ok(line.includes('-c:v libx264 -preset veryfast'));
  assert.ok(line.includes(`-b:v ${Math.round(6_000_000 * params.bitrate_factor)}`));
  assert.ok(line.includes('keyint=60:min-keyint=60:scenecut=0:bframes=2'));
  assert.ok(line.includes('h264_metadata=sei_user_data='));
  assert.ok(line.includes('-c:a copy'));
});

test('summarizeSourceProbe le o ffprobe e recusa arquivo sem video', () => {
  const summary = summarizeSourceProbe({
    streams: [
      { codec_type: 'video', codec_name: 'h264', avg_frame_rate: '30000/1001', bit_rate: '5123456', has_b_frames: 2 },
      { codec_type: 'audio', codec_name: 'aac', bit_rate: '96000', sample_rate: '48000' },
    ],
    format: { duration: '12.5' },
  });
  assert.equal(summary.videoCodec, 'h264');
  assert.equal(summary.videoBitrate, 5_123_456);
  assert.ok(Math.abs(summary.frameRate - 29.97) < 0.01);
  assert.equal(summary.audioBitrate, 96_000);
  assert.equal(summary.audioSampleRate, 48_000);
  assert.equal(summary.durationSeconds, 12.5);
  assert.throws(() => summarizeSourceProbe({ streams: [{ codec_type: 'audio' }] }), /without_video/);
  assert.deepEqual(buildFfprobeArgs('x.mp4').at(-1), 'x.mp4');
});

test('validateVariantProbe barra saida sem audio, com codec trocado ou duracao diferente', () => {
  const params = { recipe: 'micro' };
  const ok = {
    streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio' }],
    format: { duration: '15.02' },
  };
  assert.equal(validateVariantProbe({ source: h264Source, output: ok, params }), null);
  assert.equal(
    validateVariantProbe({ source: h264Source, output: { ...ok, streams: [ok.streams[0]] }, params }),
    'video_variant_output_lost_audio',
  );
  assert.equal(
    validateVariantProbe({ source: h264Source, output: { ...ok, format: { duration: '13' } }, params }),
    'video_variant_output_duration_changed',
  );
  assert.equal(
    validateVariantProbe({
      source: h264Source,
      output: { ...ok, streams: [{ codec_type: 'video', codec_name: 'hevc' }, { codec_type: 'audio' }] },
      params,
    }),
    'video_variant_output_codec_changed',
  );
  assert.equal(validateVariantProbe({ source: h264Source, output: { streams: [] }, params }), 'video_variant_output_without_video');
});

// Prova de ponta a ponta, so onde ha ffmpeg (a VPS de variantes; pulado no Windows do dono).
function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function streamMd5(filePath, map, copy) {
  const { stdout } = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', map, ...(copy ? ['-c', 'copy'] : []), '-f', 'md5', '-',
  ]);
  return stdout.trim();
}

test('bookend sorteia poucos quadros congelados e 0,5 a 2 s de preto, com semente de audio', () => {
  for (let index = 0; index < 500; index += 1) {
    const params = drawVideoVariantParams('bookend');
    assert.ok(params.freeze_frames >= 3 && params.freeze_frames <= 9);
    assert.ok(params.black_seconds >= 0.5 && params.black_seconds <= 2);
    assert.ok(Number.isInteger(params.audio_seed));
    assert.ok(Math.abs(params.audio_gain_db) >= 0.05);
  }
});

test('bookend monta pedacos e junta sem recodificar o original', () => {
  const params = { ...drawVideoVariantParams('bookend'), freeze_frames: 6, black_seconds: 1 };
  const steps = buildVariantSteps({ params, source: h264Source, inputPath: 'in.mp4', outputPath: 'out.mp4', workDir: '/w' });
  const lines = steps.map((step) => (step.kind === 'file' ? step.content : step.args.join(' ')));
  assert.equal(steps.length, 7);
  assert.ok(lines[1].includes('-frames:v 6') && lines[1].includes('-bf 0') && lines[1].includes('-video_track_timescale 15360'));
  assert.ok(lines[2].includes('color=black:s=1080x1920:r=30/1') && lines[2].includes('-frames:v 30'));
  assert.ok(lines[3].includes('-c:v copy'), 'o original entra por copia');
  assert.equal(lines[4], "file '/w/freeze.mp4'\nfile '/w/middle.mp4'\nfile '/w/black.mp4'\n");
  assert.ok(lines[5].includes('-f concat') && lines[5].includes('-c copy'));
  assert.ok(lines[6].includes('adelay=200:all=1') && lines[6].includes('apad=pad_dur=1.0000'));
  assert.ok(lines[6].includes('h264_metadata=sei_user_data=') && lines[6].includes('-movflags +faststart'));
  assert.ok(!lines.join(' ').includes('libx264 -preset veryfast -b:v'), 'nao recodifica o video inteiro');
  assert.equal(bookendExtraSeconds(params, h264Source), (6 + 30) / 30);
  assert.throws(() => buildFfmpegArgs({ params, source: h264Source, inputPath: 'a', outputPath: 'b' }), /buildVariantSteps/);
});

test('bookend recusa fonte que nao e H.264 yuv420p (so da para emendar sem recodificar nesse caso)', () => {
  const params = drawVideoVariantParams('bookend');
  assert.throws(() => buildVariantSteps({ params, source: { ...h264Source, videoCodec: 'hevc' }, inputPath: 'a', outputPath: 'b', workDir: '/w' }), /video_variant_source_unsupported/);
  assert.throws(() => buildVariantSteps({ params, source: { ...h264Source, pixFmt: 'yuv420p10le' }, inputPath: 'a', outputPath: 'b', workDir: '/w' }), /video_variant_source_unsupported/);
});

test('bookend sem audio sai so com a faixa de video marcada', () => {
  const steps = buildVariantSteps({ params: drawVideoVariantParams('bookend'), source: { ...h264Source, hasAudio: false }, inputPath: 'in.mp4', outputPath: 'out.mp4', workDir: '/w' });
  const last = steps.at(-1).args.join(' ');
  assert.ok(!last.includes('anoisesrc') && !last.includes('-c:a'));
  assert.ok(last.includes('h264_metadata=sei_user_data='));
});

test('a validacao espera a bookend mais longa que a fonte', () => {
  const params = { recipe: 'bookend', freeze_frames: 6, black_seconds: 1 };
  const output = (duration) => ({ streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio' }], format: { duration: String(duration) } });
  assert.equal(validateVariantProbe({ source: h264Source, output: output(15 + 1.2), params }), null);
  assert.equal(validateVariantProbe({ source: h264Source, output: output(15), params }), 'video_variant_output_duration_changed');
});

test('bookend_mid sorteia o congelado do meio e o ponto entre 30% e 70%, alem do que a bookend sorteia', () => {
  for (let index = 0; index < 500; index += 1) {
    const params = drawVideoVariantParams('bookend_mid');
    assert.ok(params.freeze_frames >= 3 && params.freeze_frames <= 9);
    assert.ok(params.mid_freeze_frames >= 3 && params.mid_freeze_frames <= 9);
    assert.ok(params.mid_position_pct >= 30 && params.mid_position_pct <= 70);
    assert.ok(params.black_seconds >= 0.5 && params.black_seconds <= 2);
    assert.ok(Number.isInteger(params.audio_seed));
  }
  assert.equal(drawVideoVariantParams('bookend').mid_freeze_frames, undefined);
  assert.ok(recipeNeedsKeyframes('bookend_mid') && !recipeNeedsKeyframes('bookend') && !recipeNeedsKeyframes('micro'));
});

test('parseKeyframes conta os quadros antes de cada quadro-chave pelos carimbos, em ordem de tela', () => {
  // Ordem de decodificacao com B-frames: o 0.1 chega depois do 0.2.
  const csv = ['0.000000,K__', '0.200000,___', '0.100000,___', '0.300000,___', '0.400000,K__', 'N/A,___', '0.500000,___', ''].join('\n');
  assert.deepEqual(parseKeyframes(csv), [{ seconds: 0, framesBefore: 0 }, { seconds: 0.4, framesBefore: 4 }]);
  assert.equal(buildKeyframeProbeArgs('x.mp4').at(-1), 'x.mp4');
  assert.ok(buildKeyframeProbeArgs('x.mp4').join(' ').includes('packet=pts_time,flags'));
});

test('chooseMidCut pega o quadro-chave mais perto do ponto sorteado, longe das pontas', () => {
  const source = withKeyframes();
  assert.deepEqual(chooseMidCut({ mid_position_pct: 50 }, source), { seconds: 6, framesBefore: 180 });
  assert.deepEqual(chooseMidCut({ mid_position_pct: 70 }, source), { seconds: 9, framesBefore: 270 });
  // So o quadro-chave do comeco: nao ha onde cortar.
  assert.equal(chooseMidCut({ mid_position_pct: 50 }, { ...h264Source, keyframes: [{ seconds: 0, framesBefore: 0 }] }), null);
  assert.equal(chooseMidCut({ mid_position_pct: 50 }, h264Source), null, 'sem lista de quadros-chave');
});

test('resolveVariantParams grava o corte, desiste do meio sem quadro-chave e cai para micro em fonte que nao emenda', () => {
  const drawn = { ...drawVideoVariantParams('bookend_mid'), mid_position_pct: 50 };
  const resolved = resolveVariantParams(drawn, withKeyframes());
  assert.equal(resolved.mid_cut_seconds, 6);
  assert.equal(resolved.mid_cut_frame, 180);
  assert.equal(appliedRecipe(resolved), 'bookend_mid');

  const semMeio = resolveVariantParams(drawn, { ...h264Source, keyframes: [{ seconds: 0, framesBefore: 0 }] });
  assert.equal(semMeio.mid_freeze_frames, 0);
  assert.equal(semMeio.mid_skipped, 'sem_quadro_chave_no_meio');
  assert.equal(semMeio.mid_cut_seconds, undefined);

  for (const recipe of SPLICED) {
    const hevc = resolveVariantParams(drawVideoVariantParams(recipe), { ...h264Source, videoCodec: 'hevc' });
    assert.equal(appliedRecipe(hevc), 'micro', recipe);
    const steps = buildVariantSteps({ params: hevc, source: { ...h264Source, videoCodec: 'hevc' }, inputPath: 'in.mp4', outputPath: 'out.mp4', workDir: '/w' });
    assert.equal(steps.length, 1, `${recipe} em HEVC vira um passo de micro`);
    assert.ok(steps[0].args.join(' ').includes('-c:v copy') && steps[0].args.join(' ').includes('anoisesrc'));
  }
  // Receita que nao emenda passa sem mudar.
  const micro = drawVideoVariantParams('micro');
  assert.deepEqual(resolveVariantParams(micro, h264Source), micro);
});

test('bookend_mid corta o original sem recodificar no quadro-chave, confere a metade e congela a 1a imagem da 2a metade', () => {
  const params = resolveVariantParams({ ...drawVideoVariantParams('bookend_mid'), freeze_frames: 6, mid_freeze_frames: 4, black_seconds: 1, mid_position_pct: 50 }, withKeyframes());
  const steps = buildVariantSteps({ params, source: withKeyframes(), inputPath: 'in.mp4', outputPath: 'out.mp4', workDir: '/w' });
  const lines = steps.map((step) => (step.kind === 'file' ? step.content : step.kind === 'expect_frames' ? `expect ${step.path} ${step.frames}` : step.args.join(' ')));
  const split = lines.find((line) => line.includes('-f segment'));
  assert.ok(split.includes('-c:v copy'), 'o original entra por copia');
  // Meio quadro antes do quadro-chave de 6 s: 6 - 0,5/30.
  assert.ok(split.includes('-segment_times 5.983333'));
  assert.ok(split.includes('video_track_timescale=15360'));
  assert.ok(lines.includes('expect /w/part0.mp4 180'), 'confere a primeira metade antes de seguir');
  assert.ok(lines.some((line) => line.includes("-i /w/part1.mp4") && line.includes('mid.png')), 'o congelado sai da segunda metade');
  assert.ok(lines.some((line) => line.includes('mid.png') && line.includes('-frames:v 4') && line.includes('-bf 0')));
  assert.ok(lines.includes("file '/w/freeze.mp4'\nfile '/w/part0.mp4'\nfile '/w/midfreeze.mp4'\nfile '/w/part1.mp4'\nfile '/w/black.mp4'\n"));
  const mux = lines.at(-1);
  assert.ok(mux.includes('atrim=0:6.000000') && mux.includes('atrim=6.000000') && mux.includes('apad=pad_dur=0.1333'), 'o som para no congelado do meio');
  assert.ok(mux.includes('adelay=200:all=1') && mux.includes('apad=pad_dur=1.0000'));
  assert.ok(!lines.join(' ').includes('libx264 -preset veryfast -b:v'), 'nao recodifica o video inteiro');
  assert.equal(bookendExtraSeconds(params, withKeyframes()), (6 + 4 + 30) / 30);
});

test('bookend_mid sem o meio vira bookend: mesmos passos e duracao sem o congelado do meio', () => {
  const drawn = resolveVariantParams({ ...drawVideoVariantParams('bookend_mid'), freeze_frames: 6, mid_freeze_frames: 4, black_seconds: 1, mid_position_pct: 50 }, withKeyframes());
  const params = withoutMidFreeze(drawn, 'corte_divergiu');
  assert.equal(params.mid_skipped, 'corte_divergiu');
  assert.equal(params.mid_cut_seconds, undefined);
  const steps = buildVariantSteps({ params, source: withKeyframes(), inputPath: 'in.mp4', outputPath: 'out.mp4', workDir: '/w' });
  assert.equal(steps.length, 7);
  assert.ok(!steps.some((step) => step.kind === 'expect_frames'));
  assert.equal(bookendExtraSeconds(params, h264Source), (6 + 30) / 30);
});

test('a validacao espera a bookend_mid mais longa pelo congelado do meio', () => {
  const params = { recipe: 'bookend_mid', freeze_frames: 6, mid_freeze_frames: 9, mid_cut_seconds: 6, black_seconds: 1 };
  const output = (duration) => ({ streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio' }], format: { duration: String(duration) } });
  assert.equal(validateVariantProbe({ source: h264Source, output: output(15 + 1.5), params }), null);
  assert.equal(validateVariantProbe({ source: h264Source, output: output(15 + 0.5), params }), 'video_variant_output_duration_changed');
  // Caiu para micro: duracao igual a fonte.
  assert.equal(validateVariantProbe({ source: h264Source, output: output(15.01), params: { ...params, applied_recipe: 'micro' } }), null);
});

test('com ffmpeg: duas execucoes da mesma receita sobre a mesma fonte nunca dao o mesmo arquivo', { skip: !ffmpegAvailable() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-variant-test-'));
  try {
    const sourcePath = path.join(directory, 'fonte.mp4');
    // 4 s com quadro-chave a cada 1 s e B-frames (o padrao do x264), como os videos
    // reais: e o que a bookend_mid precisa para ter onde cortar no meio.
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', sourcePath,
    ]);
    const probe = async (filePath) => JSON.parse((await run('ffprobe', buildFfprobeArgs(filePath))).stdout);
    const source = {
      ...summarizeSourceProbe(await probe(sourcePath)),
      keyframes: parseKeyframes((await run('ffprobe', buildKeyframeProbeArgs(sourcePath))).stdout),
    };
    const sourcePixels = await streamMd5(sourcePath, '0:v', false);
    const sourceAudio = await streamMd5(sourcePath, '0:a', false);
    const frameHashes = async (file) => (await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']))
      .stdout.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').at(-1).trim());
    const sourceFrames = await frameHashes(sourcePath);

    for (const recipe of VIDEO_VARIANT_RECIPES) {
      const hashes = new Set([sha256(sourcePath)]);
      for (let index = 0; index < 2; index += 1) {
        const outputPath = path.join(directory, `${recipe}-${index}.mp4`);
        const params = resolveVariantParams(drawVideoVariantParams(recipe), source);
        const workDir = fs.mkdtempSync(path.join(directory, 'passos-'));
        for (const step of buildVariantSteps({ params, source, inputPath: sourcePath, outputPath, workDir })) {
          if (step.kind === 'file') fs.writeFileSync(step.path, step.content);
          else if (step.kind === 'expect_frames') {
            const counted = Number((await run('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', step.path])).stdout.trim());
            assert.equal(counted, step.frames, `${recipe}: a primeira metade do corte tem o tamanho esperado`);
          } else await run('ffmpeg', step.args);
        }
        assert.equal(validateVariantProbe({ source, output: await probe(outputPath), params }), null, recipe);
        hashes.add(sha256(outputPath));
        const head = fs.readFileSync(outputPath).subarray(0, 4096).toString('latin1');
        assert.ok(head.includes('moov'), `${recipe}: moov na frente`);
        if (recipe === 'bookend' || recipe === 'bookend_mid') {
          // O original entra intacto entre os pedacos novos: quadro a quadro, a saida e
          // congelados + fonte (cortada no meio, na bookend_mid) + preto.
          const output = await frameHashes(outputPath);
          const middle = recipe === 'bookend_mid' ? params.mid_freeze_frames : 0;
          const black = Math.round(params.black_seconds * 30);
          assert.equal(output.length, sourceFrames.length + params.freeze_frames + middle + black, `${recipe}: quadros a mais`);
          if (recipe === 'bookend_mid') {
            assert.ok(params.mid_cut_frame > 0, 'a fonte de teste tem onde cortar');
            const cut = params.mid_cut_frame;
            const first = output.slice(params.freeze_frames, params.freeze_frames + cut);
            const second = output.slice(params.freeze_frames + cut + middle, params.freeze_frames + sourceFrames.length + middle);
            assert.deepEqual(first, sourceFrames.slice(0, cut), 'bookend_mid: metade antes do corte identica a fonte');
            assert.deepEqual(second, sourceFrames.slice(cut), 'bookend_mid: metade depois do corte identica a fonte');
          } else {
            assert.deepEqual(output.slice(params.freeze_frames, params.freeze_frames + sourceFrames.length), sourceFrames, 'bookend: original identico');
          }
        } else if (recipe !== 'light') {
          assert.equal(await streamMd5(outputPath, '0:v', false), sourcePixels, `${recipe}: pixels intactos`);
        } else {
          assert.notEqual(await streamMd5(outputPath, '0:v', false), sourcePixels, 'light: pixels mudam');
        }
        if (recipe === 'micro' || recipe === 'bookend' || recipe === 'bookend_mid') {
          assert.notEqual(await streamMd5(outputPath, '0:a', false), sourceAudio, 'micro: audio muda');
        }
      }
      assert.equal(hashes.size, 3, `${recipe}: fonte e duas variantes com SHA-256 diferentes`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
