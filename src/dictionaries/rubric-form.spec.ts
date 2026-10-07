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

  it('reads the production shape (rubric_features / feature_choices, attrs__ prefix)', () => {
    // Trimmed from GET /items/rubric_form/21/ on pin.tt, 2026-10-07.
    const form = parseRubricForm(21, {
      id: 21,
      name: 'Residential rent',
      slug: 'residential-rent',
      rubric_features: [
        {
          feature_name: 'attrs__geo-hidden',
          feature_verbose_name: 'Pick a point',
          feature_type: 'geo',
          feature_type_id: 7,
          feature_choices: [],
          required: false,
          geo: true,
        },
        {
          feature_name: 'attrs__bedrooms',
          feature_verbose_name: 'Number of bedrooms',
          feature_type: 'Integer choices',
          feature_type_id: 4,
          feature_choices: [
            { key: '100', value: 'Studio' },
            { key: '1', value: '1' },
            { key: '10', value: '3' },
            { key: '9', value: '9+' },
          ],
          filter_feature: true,
          required: true,
          measure: null,
          req_text: 'Required',
          geo: false,
        },
        {
          feature_name: 'attrs__pets',
          feature_verbose_name: 'Pets',
          feature_type: 'Integer choices',
          feature_type_id: 4,
          feature_choices: [
            { key: '1', value: 'Allowed' },
            { key: '2', value: 'Not allowed' },
          ],
          required: false,
          geo: false,
        },
        {
          feature_name: 'attrs__water',
          feature_verbose_name: 'Water',
          feature_type: 'Integer multi choices',
          feature_choices: [
            { key: '1', value: 'Hot' },
            { key: '2', value: 'Cold' },
          ],
          required: false,
          geo: false,
        },
        {
          feature_name: 'attrs__floor-area',
          feature_verbose_name: 'Floor area',
          feature_type: 'Integer',
          feature_choices: [],
          required: false,
          geo: false,
        },
        {
          feature_name: 'attrs__village',
          feature_verbose_name: 'Village',
          feature_type: 'String',
          feature_choices: [],
          required: true,
          geo: false,
        },
      ],
    });
    expect(form.fields).toEqual([
      {
        slug: 'bedrooms',
        title: 'Number of bedrooms',
        required: true,
        kind: 'select',
        variants: [
          { key: 100, label: 'Studio' },
          { key: 1, label: '1' },
          { key: 10, label: '3' },
          { key: 9, label: '9+' },
        ],
      },
      {
        slug: 'pets',
        title: 'Pets',
        required: false,
        kind: 'select',
        variants: [
          { key: 1, label: 'Allowed' },
          { key: 2, label: 'Not allowed' },
        ],
      },
      {
        slug: 'water',
        title: 'Water',
        required: false,
        kind: 'multiselect',
        variants: [
          { key: 1, label: 'Hot' },
          { key: 2, label: 'Cold' },
        ],
      },
      { slug: 'floor-area', title: 'Floor area', required: false, kind: 'number', variants: [] },
      { slug: 'village', title: 'Village', required: true, kind: 'text', variants: [] },
    ]);
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
