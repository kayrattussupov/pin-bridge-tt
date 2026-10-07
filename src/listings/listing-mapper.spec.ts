import { describe, expect, it } from 'vitest';
import { RUBRIC_FORMS } from '../../test/fake-pin/fake-pin';
import { parseRubricForm } from '../dictionaries/rubric-form';
import { mapListing, pinExternalId } from './listing-mapper';
import { ListingInput, listingSchema } from './listing.schema';

const form = parseRubricForm(21, RUBRIC_FORMS[21]);
const ctx = { form, agencySlug: 'duck', displayName: 'Duck Realty' };

function listing(overrides: Record<string, unknown> = {}): ListingInput {
  return listingSchema.parse({
    external_id: '8842',
    category: 'residential_rent',
    title: '2-bedroom apartment in Valsayn',
    description: 'Fully furnished, A/C, gated community, parking.',
    price: 3500,
    region: 'central',
    coordinates: { lat: 10.65, lng: -61.41 },
    images: ['https://cdn.example.com/1.jpg'],
    attributes: {
      type: 'Apartment',
      bedrooms: 2,
      'number-of-bathrooms': 2,
      water: ['WASA', 'Tank'],
      'floor-area': 1200,
    },
    ...overrides,
  });
}

describe('mapListing', () => {
  it('produces the Pin payload from the integration notes', () => {
    const result = mapListing(listing(), ctx);
    expect(result.errors).toEqual([]);
    expect(result.payload).toEqual({
      rubric: 21,
      city: 17,
      currency_id: 1,
      title: '2-bedroom apartment in Valsayn',
      description: 'Fully furnished, A/C, gated community, parking.',
      price: 3500,
      images: [],
      coordinates: { latitude: 10.65, longitude: -61.41 },
      user: { name: 'Duck Realty', email: '' },
      phone_hide: false,
      negotiable_price: false,
      external_id: 'duck.8842',
      item_link: '',
      attrs: {
        attrs__type: 2,
        attrs__bedrooms: 2,
        'attrs__number-of-bathrooms': 30,
        attrs__water: [10, 20],
        'attrs__floor-area': 1200,
      },
    });
    expect(result.imageUrls).toEqual(['https://cdn.example.com/1.jpg']);
  });

  it('maps human values to variant keys, not to the same number', () => {
    // "3 bedrooms" is key 10 on Pin; sending 3 would mean something else.
    expect(
      mapListing(listing({ attributes: { type: 'apartment', bedrooms: 3 } }), ctx).payload?.attrs,
    ).toEqual({
      attrs__type: 2,
      attrs__bedrooms: 10,
    });
  });

  it('matches case- and space-insensitively, and numbers above an "N+" variant', () => {
    const attrs = mapListing(listing({ attributes: { type: '  TOWNHOUSE ', bedrooms: 6 } }), ctx)
      .payload?.attrs;
    expect(attrs).toEqual({ attrs__type: 3, attrs__bedrooms: 11 });
  });

  it('reports every problem at once with allowed values', () => {
    const result = mapListing(
      listing({
        attributes: { bedrooms: 'seven', water: ['WASA', 'Well'], pool: true, 'floor-area': 'big' },
      }),
      ctx,
    );
    expect(result.payload).toBeUndefined();
    expect(result.errors.map((e) => [e.field, e.code])).toEqual([
      ['attributes.bedrooms', 'unknown_value'],
      ['attributes.water', 'unknown_value'],
      ['attributes.pool', 'unknown_attribute'],
      ['attributes.floor-area', 'not_a_number'],
      ['attributes.type', 'required'],
    ]);
    expect(result.errors[0]?.allowed).toEqual(['1', '2', '3', '4+']);
  });

  it('rejects an array for a single-choice attribute', () => {
    const result = mapListing(
      listing({ attributes: { type: ['House', 'Apartment'], bedrooms: 1 } }),
      ctx,
    );
    expect(result.errors[0]).toMatchObject({
      field: 'attributes.type',
      code: 'single_value_expected',
    });
  });

  it('lets pin_attrs override with raw keys', () => {
    const result = mapListing(listing({ pin_attrs: { bedrooms: 11, furnishing: 1 } }), ctx);
    expect(result.payload?.attrs).toMatchObject({ attrs__bedrooms: 11, attrs__furnishing: 1 });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: 'pin_attrs.furnishing' }),
    );
  });

  it('accepts pin_attrs keys that already carry the attrs__ prefix', () => {
    const result = mapListing(
      listing({ attributes: { type: 'House' }, pin_attrs: { attrs__bedrooms: 11 } }),
      ctx,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ field: 'pin_attrs.attrs__bedrooms' }),
    );
    expect(result.payload?.attrs).toEqual({ attrs__type: 1, attrs__bedrooms: 11 });
  });

  it('uses contact overrides and the link', () => {
    const payload = mapListing(
      listing({
        contact: { name: 'Jane', email: 'jane@example.com', hide_phone: true },
        link: 'https://duck.tt/l/8842',
      }),
      ctx,
    ).payload;
    expect(payload).toMatchObject({
      user: { name: 'Jane', email: 'jane@example.com' },
      phone_hide: true,
      item_link: 'https://duck.tt/l/8842',
    });
  });

  it('checks districts against the region', () => {
    const districts = [{ id: 1701, name: 'Valsayn' }];
    const ok = mapListing(listing({ district_ids: [1701] }), { ...ctx, districts });
    expect(ok.payload?.city_districts).toEqual([1701]);
    const bad = mapListing(listing({ district_ids: [9999] }), { ...ctx, districts });
    expect(bad.errors).toContainEqual(
      expect.objectContaining({ field: 'district_ids', code: 'unknown_district' }),
    );
  });

  it('warns about paid placement, swapped coordinates, image count', () => {
    const images = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const result = mapListing(
      listing({ price: 6000, coordinates: { lat: -61.41, lng: 10.65 }, images }),
      ctx,
    );
    expect(result.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['may_be_paid', 'outside_trinidad_and_tobago', 'too_many_images']),
    );
    expect(result.imageUrls).toHaveLength(16);
    expect(mapListing(listing({ price: 4000 }), ctx).warnings.map((w) => w.code)).not.toContain(
      'may_be_paid',
    );
  });
});

describe('listingSchema', () => {
  it('rejects unknown fields and bad values', () => {
    const result = listingSchema.safeParse({
      external_id: 'has space',
      category: 'commercial',
      title: 'x',
      price: -5,
      region: 'mars',
      images: ['not a url'],
      colour: 'red',
    });
    expect(result.success).toBe(false);
    const fields = result.error!.issues.map((i) => i.path.join('.') || i.code);
    expect(fields).toEqual(
      expect.arrayContaining([
        'external_id',
        'category',
        'title',
        'price',
        'region',
        'images.0',
        'unrecognized_keys',
      ]),
    );
  });

  it('cleans control characters and excess blank lines from text', () => {
    const parsed = listing({ title: '  Nice\u0000 house  ', description: 'a\r\n\r\n\r\n\r\nb' });
    expect(parsed.title).toBe('Nice house');
    expect(parsed.description).toBe('a\n\nb');
  });
});

describe('pinExternalId', () => {
  it('cannot collide between agencies', () => {
    expect(pinExternalId('duck', 'realty-1')).not.toBe(pinExternalId('duck-realty', '1'));
    expect(pinExternalId('duck', '8842')).toBe('duck.8842');
  });
});
