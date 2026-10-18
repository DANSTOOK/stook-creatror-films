import { describe, expect, it } from 'vitest';
import {
  CATEGORY_NAME,
  TEMPLATE_CATEGORIES,
  TITLE_TEMPLATES,
  frameFactor,
  isTemplateId,
  searchable,
  styleForFrame,
  templateById,
  templateMatches,
  templateOf,
  titleFromTemplate,
} from '@renderer/text/templates';
import { TITLE_ENTRANCES, TITLE_EXITS } from '@renderer/text/animation';
import { normalizeTitle, isTitlePreset, TITLE_ANCHORS } from '@renderer/text/titleStyle';
import { SHAPE_KINDS } from '@renderer/text/titleStyle';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';

/**
 * The title library (text/templates): a large, valid set of templates, every
 * one named and written in both languages, that fit any project and survive
 * being saved and opened again.
 */

const HD = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

describe('the library', () => {
  it('has well over forty templates, spread across every category', () => {
    expect(TITLE_TEMPLATES.length).toBeGreaterThanOrEqual(40);
    for (const category of TEMPLATE_CATEGORIES) {
      const count = TITLE_TEMPLATES.filter((template) => template.category === category).length;
      expect(count, category).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every template a unique id', () => {
    const ids = TITLE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the three original templates under their old ids and presets', () => {
    for (const preset of ['title', 'lowerThird', 'credits'] as const) {
      const template = templateById(preset);
      expect(template?.preset).toBe(preset);
      expect(template?.id).toBe(preset);
    }
  });

  it('lists templates grouped by category, in the category order', () => {
    const order = TITLE_TEMPLATES.map((template) => TEMPLATE_CATEGORIES.indexOf(template.category));
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
  });
});

describe('every template is valid', () => {
  for (const template of TITLE_TEMPLATES) {
    it(`${template.id} is well-formed, fits any frame and round-trips`, () => {
      expect(isTitlePreset(template.preset)).toBe(true);
      expect(TITLE_ENTRANCES).toContain(template.animation.in);
      expect(TITLE_EXITS).toContain(template.animation.out);
      expect(TITLE_ANCHORS).toContain(template.style.anchor);
      expect(template.seconds).toBeGreaterThan(0);
      if (template.style.shape) expect(SHAPE_KINDS).toContain(template.style.shape.kind);
      // Colours are #rrggbb.
      expect(template.style.color).toMatch(/^#[0-9a-f]{6}$/i);

      // Every template has both languages, with no missing or empty strings.
      for (const dict of [en, es]) {
        expect(typeof dict[template.name], template.name).toBe('string');
        expect((dict[template.name] as string).length).toBeGreaterThan(0);
        expect(typeof dict[template.text], template.text).toBe('string');
      }

      // Made into a title, then saved and opened: it reads back the same.
      const made = titleFromTemplate(template, 'Prueba áéíóú ñ ¿¡', HD);
      const read = normalizeTitle(made);
      expect(read).toEqual(made);
      // Its template id survives (the originals go by preset, with no id).
      if (template.id !== template.preset) expect(read.template).toBe(template.id);
      else expect(read.template).toBeUndefined();
    });
  }
});

describe('fitting a template to the project', () => {
  it('leaves a landscape template alone on a landscape frame', () => {
    const template = templateById('basic-subtitle')!;
    expect(frameFactor(template, HD)).toBeCloseTo(1, 6);
    expect(styleForFrame(template, HD)).toBe(template.style);
  });

  it('shrinks a landscape template on a vertical frame, so its letters keep their size by the short side', () => {
    const template = templateById('basic-subtitle')!;
    const factor = frameFactor(template, VERTICAL);
    expect(factor).toBeCloseTo(9 / 16, 3);
    expect(styleForFrame(template, VERTICAL).fontSize).toBeCloseTo(template.style.fontSize * factor, 6);
  });

  it('draws a vertical template at its designed size on a vertical frame', () => {
    const template = TITLE_TEMPLATES.find((candidate) => candidate.vertical)!;
    expect(frameFactor(template, VERTICAL)).toBeCloseTo(1, 3);
  });

  it('scales a shape, stroke and shadow with the text', () => {
    const template = templateById('lt-accent')!;
    const scaled = styleForFrame(template, VERTICAL);
    const factor = frameFactor(template, VERTICAL);
    expect(scaled.shape?.size).toBeCloseTo((template.style.shape?.size ?? 0) * factor, 6);
    expect(scaled.shadow.blur).toBeCloseTo(template.style.shadow.blur * factor, 6);
  });
});

describe('finding a template', () => {
  it('matches by name, ignoring accents and case', () => {
    const lower = templateById('lt-accent')!;
    const hay = [en[lower.name] as string, en[lower.text] as string, 'Lower thirds', lower.id];
    expect(templateMatches(hay, 'accent')).toBe(true);
    expect(templateMatches(hay, 'ACCENT')).toBe(true);
  });

  it('finds Spanish text whether or not the query has accents', () => {
    const quote = templateById('call-quote')!;
    const hay = [es[quote.name] as string, es[quote.text] as string, 'Llamadas', quote.id];
    expect(templateMatches(hay, 'sueña')).toBe(true);
    expect(templateMatches(hay, 'suena')).toBe(true);
  });

  it('needs every word of the query to appear', () => {
    expect(templateMatches(['Lower third news'], 'news lower')).toBe(true);
    expect(templateMatches(['Lower third news'], 'news sport')).toBe(false);
  });

  it('folds accents away', () => {
    expect(searchable('Título Ññ')).toBe('titulo nn');
  });
});

describe('an unknown template', () => {
  it('is not a known id', () => {
    expect(isTemplateId('basic-subtitle')).toBe(true);
    expect(isTemplateId('made-up-id')).toBe(false);
  });

  it('falls back to the title preset for a title saved by a newer build', () => {
    // A title that names a template this build has never heard of.
    const read = normalizeTitle({ preset: 'title', text: 'Hi', template: 'from-the-future' });
    // The id is kept, so a round trip through a newer build still has it.
    expect(read.template).toBe('from-the-future');
    // But resolving it here gives the plain title template.
    expect(templateOf(read).id).toBe('title');
  });

  it('drops a template id that is not shaped like one', () => {
    const read = normalizeTitle({ preset: 'title', text: 'Hi', template: 'has spaces and symbols!' });
    expect(read.template).toBeUndefined();
  });
});

describe('CATEGORY_NAME', () => {
  it('names every category in both languages', () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(typeof en[CATEGORY_NAME[category]]).toBe('string');
      expect(typeof es[CATEGORY_NAME[category]]).toBe('string');
    }
  });
});
