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
  VIDEO_VARIANT_RECIPES,
  buildFfmpegArgs,
  buildFfprobeArgs,
  drawVideoVariantParams,
  isVideoVariantRecipe,
  summarizeSourceProbe,
  validateVariantProbe,
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
});

function argsFor(recipe, source = h264Source) {
  const params = drawVideoVariantParams(recipe);
  return { params, args: buildFfmpegArgs({ params, source, inputPath: 'in.mp4', outputPath: 'out.mp4' }) };
}

test('micro e a receita padrao e visible nao existe', () => {
  assert.equal(DEFAULT_VIDEO_VARIANT_RECIPE, 'micro');
  assert.deepEqual([...VIDEO_VARIANT_RECIPES], ['container', 'micro', 'light']);
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
  for (const recipe of VIDEO_VARIANT_RECIPES) {
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

test('com ffmpeg: duas execucoes da mesma receita sobre a mesma fonte nunca dao o mesmo arquivo', { skip: !ffmpegAvailable() }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-variant-test-'));
  try {
    const sourcePath = path.join(directory, 'fonte.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', sourcePath,
    ]);
    const probe = async (filePath) => JSON.parse((await run('ffprobe', buildFfprobeArgs(filePath))).stdout);
    const source = summarizeSourceProbe(await probe(sourcePath));
    const sourcePixels = await streamMd5(sourcePath, '0:v', false);
    const sourceAudio = await streamMd5(sourcePath, '0:a', false);

    for (const recipe of VIDEO_VARIANT_RECIPES) {
      const hashes = new Set([sha256(sourcePath)]);
      for (let index = 0; index < 2; index += 1) {
        const outputPath = path.join(directory, `${recipe}-${index}.mp4`);
        const params = drawVideoVariantParams(recipe);
        await run('ffmpeg', buildFfmpegArgs({ params, source, inputPath: sourcePath, outputPath }));
        assert.equal(validateVariantProbe({ source, output: await probe(outputPath), params }), null, recipe);
        hashes.add(sha256(outputPath));
        const head = fs.readFileSync(outputPath).subarray(0, 4096).toString('latin1');
        assert.ok(head.includes('moov'), `${recipe}: moov na frente`);
        if (recipe !== 'light') {
          assert.equal(await streamMd5(outputPath, '0:v', false), sourcePixels, `${recipe}: pixels intactos`);
        } else {
          assert.notEqual(await streamMd5(outputPath, '0:v', false), sourcePixels, 'light: pixels mudam');
        }
        if (recipe === 'micro') {
          assert.notEqual(await streamMd5(outputPath, '0:a', false), sourceAudio, 'micro: audio muda');
        }
      }
      assert.equal(hashes.size, 3, `${recipe}: fonte e duas variantes com SHA-256 diferentes`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
