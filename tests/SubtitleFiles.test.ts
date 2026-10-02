import { describe, expect, it } from 'vitest';
import { formatTimestamp, parseSubtitles, subtitleFormatOf, writeSrt, writeSubtitles, writeVtt, type SubtitleCue } from '@renderer/captions/subtitleFiles';

const CUES: SubtitleCue[] = [
  { startMs: 0, endMs: 1940, text: 'Buenos días a todos.' },
  { startMs: 2007, endMs: 5707, text: 'Hoy vamos a editar un vídeo corto\nsobre la ciudad de Guadalajara,' },
  { startMs: 3_723_004, endMs: 3_725_500, text: '¿Qué tal? ¡Bien!' },
];

describe('subtitle files', () => {
  it('writes SubRip: numbered, comma milliseconds, CRLF', () => {
    expect(writeSrt(CUES)).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:01,940',
        'Buenos días a todos.',
        '',
        '2',
        '00:00:02,007 --> 00:00:05,707',
        'Hoy vamos a editar un vídeo corto',
        'sobre la ciudad de Guadalajara,',
        '',
        '3',
        '01:02:03,004 --> 01:02:05,500',
        '¿Qué tal? ¡Bien!',
        '',
      ].join('\r\n'),
    );
  });

  it('writes WebVTT: the header, dot milliseconds, LF', () => {
    expect(writeVtt(CUES.slice(0, 2))).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.940\nBuenos días a todos.\n\n00:00:02.007 --> 00:00:05.707\nHoy vamos a editar un vídeo corto\nsobre la ciudad de Guadalajara,\n',
    );
  });

  it('reads back exactly what it wrote, and writes it again byte for byte', () => {
    for (const format of ['srt', 'vtt'] as const) {
      const written = writeSubtitles(format, CUES);
      const read = parseSubtitles(written);
      expect(read).toEqual(CUES);
      expect(writeSubtitles(format, read)).toBe(written);
    }
  });

  it('reads files from elsewhere: BOM, LF, bad numbers, dots, short times, markup, VTT blocks', () => {
    const srt = '\uFEFF7\n00:00:01.5 --> 00:00:03,25\n<i>Hola</i> {\\an8}mundo\n\n\n00:04,000 --> 00:06,000\n- ¿Sí?\n- No.\n\nnot a cue\n';
    expect(parseSubtitles(srt)).toEqual([
      { startMs: 1500, endMs: 3250, text: 'Hola mundo' },
      { startMs: 4000, endMs: 6000, text: '- ¿Sí?\n- No.' },
    ]);
    const vtt = 'WEBVTT - made elsewhere\n\nNOTE a comment\nover two lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 line:90% align:center\n<v Ana>Tom &amp; Ana</v>\n\n00:00:00.200 --> 00:00:00.900\n<c.yellow>Antes</c>\n';
    expect(parseSubtitles(vtt)).toEqual([
      { startMs: 200, endMs: 900, text: 'Antes' },
      { startMs: 1000, endMs: 2000, text: 'Tom & Ana' },
    ]);
  });

  it('drops cues with nothing to show or that end before they start', () => {
    expect(parseSubtitles('1\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n2\n00:00:06,000 --> 00:00:07,000\n\n')).toEqual([]);
  });

  it('keeps a cue whole when its text has an empty line in it', () => {
    const written = writeSrt([{ startMs: 0, endMs: 1000, text: 'Uno\n\nDos\n' }]);
    expect(parseSubtitles(written)).toEqual([{ startMs: 0, endMs: 1000, text: 'Uno\nDos' }]);
  });

  it('formats times past an hour and rounds to the millisecond', () => {
    expect(formatTimestamp(3_723_004.4, ',')).toBe('01:02:03,004');
    expect(formatTimestamp(-5, '.')).toBe('00:00:00.000');
  });

  it('tells the format from the name', () => {
    expect(subtitleFormatOf('C:\\v\\Mi vídeo.SRT')).toBe('srt');
    expect(subtitleFormatOf('a.vtt')).toBe('vtt');
    expect(subtitleFormatOf('a.txt')).toBeNull();
  });
});
