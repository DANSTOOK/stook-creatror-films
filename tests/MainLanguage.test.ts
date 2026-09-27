import { afterEach, describe, expect, it } from 'vitest';

import { lastLines, mt, setMainLanguage } from '@main/language';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';

/**
 * What the main process says - native dialog titles, the errors its handlers
 * throw, FFmpeg's failures - follows the language the page reported.
 */

afterEach(() => setMainLanguage('en'));

describe('main-process messages', () => {
  it('are English until the page says otherwise', () => {
    expect(mt('main.importTitle')).toBe('Import media');
  });

  it('follow the page into Spanish', () => {
    setMainLanguage('es');
    expect(mt('main.importTitle')).toBe('Importar medios');
    expect(mt('main.ytDeclined')).toBe('Se rechazó el inicio de sesión.');
  });

  it('wrap FFmpeg\'s own words in a sentence, keeping the detail', () => {
    setMainLanguage('es');
    const stderr = 'frame=  10 fps=0.0\n[libx264 @ 0x1] width not divisible by 2 (1281x720)\nError initializing output stream 0:0\n';
    const message = mt('main.ffmpegFailed', { code: '1', detail: lastLines(stderr) });
    expect(message).toMatch(/^FFmpeg se detuvo con el código 1\./);
    expect(message).toContain('width not divisible by 2 (1281x720)');
    expect(message).toContain('Error initializing output stream 0:0');
  });

  it('keeps only the last few lines of a long complaint', () => {
    const long = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n');
    expect(lastLines(long)).toBe('line 47 / line 48 / line 49');
    expect(lastLines('x'.repeat(1000)).length).toBeLessThanOrEqual(401);
  });

  it('exist in both dictionaries', () => {
    const mainKeys = Object.keys(en).filter((key) => key.startsWith('main.'));
    expect(mainKeys.length).toBeGreaterThan(50);
    for (const key of mainKeys) expect(es[key as keyof typeof es], key).toBeTruthy();
  });
});
