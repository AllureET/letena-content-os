// The narration actually reaching the finished cut (22 Aug 2026).
//
// Owner's verdict on the first real end-to-end run: "there is no voice over
// audio but the music is nice". Both halves were true. Assembly concatenated
// the shots and mixed music over them and never touched the per-shot VOICE
// assets, so the studio generated Azure Amharic narration, stored it, listed
// it on screen, and then shipped a wordless video.
//
// The `hasVoice` flag made it look right from the inside: assembly checked
// that voice assets existed and ducked the music by 93 percent to make room
// for a voice it never added. The cut came out quiet AND silent.
//
// These run real ffmpeg against real audio, because the bug was in what
// reached the file and a mocked assembly would have proved nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-voiceasm-test-storage';

const { layVoiceOntoVideo, probeClipForTest } = await import('../src/modules/studio.mjs');
const { pool } = await import('../src/core.mjs');
const run = promisify(execFile);

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'lcos-voice-')); });
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); await pool.end(); });

const silentVideo = async (name, seconds) => {
  const p = join(dir, name);
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc=size=320x568:duration=${seconds}:rate=25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(seconds), p]);
  return p;
};
const tone = async (name, seconds, freq) => {
  const p = join(dir, name);
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a', 'aac', '-t', String(seconds), p]);
  return p;
};
const probe = async (p) => {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type', '-of', 'json', p]);
  const j = JSON.parse(stdout);
  return { durationS: Number(j.format.duration),
    streams: j.streams.map(s => s.codec_type).sort() };
};

test('the narration is on the finished file, not just in the asset list', async () => {
  const video = await silentVideo('v.mp4', 10);
  const voiceTracks = [
    { shotCode: 'SH-01', path: await tone('a1.m4a', 4, 440), durationS: 4 },
    { shotCode: 'SH-02', path: await tone('a2.m4a', 4, 660), durationS: 4 },
  ];
  const r = await layVoiceOntoVideo({ workDir: dir, videoPath: video, voiceTracks });
  const out = await probe(r.path);
  assert.deepEqual(out.streams, ['audio', 'video'], 'a silent cut is the bug this file exists for');
  assert.equal(r.voiceEnd, 8);
  assert.equal(r.heldS, 0, 'the read fits inside the picture, so nothing is held');
});

test('lines play back to back, so a long line never collides with the next', async () => {
  // Real Amharic lines on this script ran 2.8 to 6.9 seconds against
  // 5-second shots. Anchoring each to its own shot's start would overlap
  // two clinical sentences; trimming to fit would cut one in half.
  const video = await silentVideo('v2.mp4', 20);
  const voiceTracks = [
    { shotCode: 'SH-01', path: await tone('b1.m4a', 6.9, 440), durationS: 6.9 },
    { shotCode: 'SH-02', path: await tone('b2.m4a', 2.8, 660), durationS: 2.8 },
    { shotCode: 'SH-03', path: await tone('b3.m4a', 5, 880), durationS: 5 },
  ];
  const r = await layVoiceOntoVideo({ workDir: dir, videoPath: video, voiceTracks });
  assert.ok(Math.abs(r.voiceEnd - 14.7) < 0.01, 'total read is the sum of the lines, none dropped');
  const out = await probe(r.path);
  assert.ok(out.durationS >= 14.6, 'and all of it is inside the file');
});

test('when the read outlasts the picture, the picture is held rather than the words cut', async () => {
  const video = await silentVideo('v3.mp4', 6);
  const voiceTracks = [
    { shotCode: 'SH-01', path: await tone('c1.m4a', 5, 440), durationS: 5 },
    { shotCode: 'SH-02', path: await tone('c2.m4a', 5, 660), durationS: 5 },
  ];
  const r = await layVoiceOntoVideo({ workDir: dir, videoPath: video, voiceTracks });
  assert.ok(r.heldS > 3.9 && r.heldS < 4.1, 'four seconds of narration had nowhere to go');
  const out = await probe(r.path);
  assert.ok(out.durationS > 9.8, 'losing the closing line is worse than a held frame');
});

test('no narration leaves the picture exactly as it was', async () => {
  const video = await silentVideo('v4.mp4', 5);
  const r = await layVoiceOntoVideo({ workDir: dir, videoPath: video, voiceTracks: [] });
  assert.equal(r.path, video, 'a project with no voice must not be re-encoded for nothing');
  assert.equal(r.heldS, 0);
});
