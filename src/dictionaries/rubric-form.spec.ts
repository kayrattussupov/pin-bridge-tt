import { describe, expect, it } from 'vitest';
import { RUBRIC_FORMS } from '../../test/fake-pin/fake-pin';
import { RubricFormParseError, parseRubricForm } from './rubric-form';

describe('parseRubricForm', () => {
  it('reads the fake-pin shape (fields / variants with key + value)', () => {
    const form = parseRubricForm(21, RUBRIC_FORMS[21]);
    const bedrooms = form.fields.find((f) => f.slug === 'bedrooms');
    expect(bedrooms).toMatchObject({ required: true, kind: 'select' });
    expect(bedrooms?.variants).toContainEqual({ key: 10, label: '3' });
    expect(form.fields.find((f) => f.slug === 'water')?.kind).toBe('multiselect');
    expect(form.fields.find((f) => f.slug === 'floor-area')?.kind).toBe('number');
  });

  it('reads a root array with choices / id / name and type hints', () => {
    const form = parseRubricForm(20, [
      {
        key: 'type',
        name: 'Property type',
        is_required: true,
        widget: 'select',
        choices: [
          { id: 7, name: 'Villa' },
          { id: 8, name: 'Bungalow' },
        ],
      },
      {
        slug: 'amenities',
        title: 'Amenities',
        type: 'checkbox',
        options: [{ value: 3, label: 'Pool' }],
      },
      { slug: 'plot-size', title: 'Plot', type: 'integer' },
      { slug: 'notes', type: 'text' },
    ]);
    expect(form.fields).toEqual([
      {
        slug: 'type',
        title: 'Property type',
        required: true,
        kind: 'select',
        variants: [
          { key: 7, label: 'Villa' },
          { key: 8, label: 'Bungalow' },
        ],
      },
      {
        slug: 'amenities',
        title: 'Amenities',
        required: false,
        kind: 'multiselect',
        variants: [{ key: 3, label: 'Pool' }],
      },
      { slug: 'plot-size', title: 'Plot', required: false, kind: 'number', variants: [] },
      { slug: 'notes', title: 'notes', required: false, kind: 'text', variants: [] },
    ]);
  });

  it('finds fields nested one level down', () => {
    const form = parseRubricForm(21, {
      data: { features: [{ slug: 'x', values: [{ key: 1, value: 'A' }] }] },
    });
    expect(form.fields[0]?.variants).toEqual([{ key: 1, label: 'A' }]);
  });

  it('fails loudly on an unknown shape instead of mapping nothing', () => {
    expect(() => parseRubricForm(21, { html: '<form/>' })).toThrow(RubricFormParseError);
    expect(() => parseRubricForm(21, null)).toThrow(RubricFormParseError);
  });
});
