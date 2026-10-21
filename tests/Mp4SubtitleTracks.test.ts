import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { switchOffSubtitleTracks } from '../src/main/exporter/mp4Tracks';

/**
 * ffmpeg enables the first subtitle track of an MP4 or MOV whatever it is
 * told; the export switches them off afterwards. Checked on files ffmpeg
 * writes, and read back by ffmpeg, which reports an enabled track as
 * "(default)".
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');
const dir = mkdtempSync(join(tmpdir(), 'scf-subs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const srt = (name: string, text: string): string => {
  const file = join(dir, name);
  writeFileSync(file, `1\n00:00:00,000 --> 00:00:01,500\n${text}\n\n`);
  return file;
};

function makeFile(name: string, extra: string[] = []): string {
  const file = join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
    '-i', srt('es.srt', 'Hola'),
    '-i', srt('en.srt', 'Hello'),
    '-map', '0:v:0', '-map', '1:0', '-map', '2:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=spa', '-metadata:s:s:1', 'language=eng',
    '-disposition:s:0', '0', '-disposition:s:1', '0',
    ...extra, file,
  ]);
  return file;
}

/** What ffmpeg says of each stream: one line per stream. */
const streamLines = (file: string): string[] =>
  (spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr ?? '').split(/\r?\n/).filter((line) => /Stream #0:\d/.test(line));

describe('subtitle tracks left switched off', () => {
  for (const [name, extra] of [['plain.mp4', []], ['faststart.mp4', ['-movflags', '+faststart']], ['film.mov', []]] as const) {
    it(`${name}: ffmpeg enables the first one; afterwards none is, and the picture still is`, async () => {
      const file = makeFile(name, [...extra]);
      const before = streamLines(file).filter((line) => /Subtitle/.test(line));
      expect(before).toHaveLength(2);
      expect(before.some((line) => /\(default\)/.test(line))).toBe(true);
      const bytes = statSync(file).size;

      expect(await switchOffSubtitleTracks(file)).toBe(1);

      const after = streamLines(file);
      expect(after.filter((line) => /Subtitle/.test(line))).toHaveLength(2);
      expect(after.filter((line) => /Subtitle/.test(line) && /\(default\)/.test(line))).toHaveLength(0);
      expect(after.find((line) => /Video/.test(line))).toMatch(/\(default\)/);
      expect(statSync(file).size).toBe(bytes);
      // Both tracks still read back whole.
      const out = join(dir, `${name}.en.srt`);
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', file, '-map', '0:s:1', out]);
      expect(statSync(out).size).toBeGreaterThan(10);
      // A second run finds nothing left to do.
      expect(await switchOffSubtitleTracks(file)).toBe(0);
    });
  }

  it('leaves a file with no subtitles alone', async () => {
    const file = join(dir, 'none.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    expect(await switchOffSubtitleTracks(file)).toBe(0);
  });
});
