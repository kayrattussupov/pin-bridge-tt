/**
 * Fixed parts of Pin's catalog that agencies refer to by name. Values come from Pin's developer
 * (ClickUp task): rubric ids, region ids ("city" on pin.tt is the region), currency 1 = TT$.
 */

export const CATEGORIES = {
  residential_sale: { rubric: 20, title: 'Residential sale' },
  residential_rent: { rubric: 21, title: 'Residential rent' },
} as const;
export type Category = keyof typeof CATEGORIES;
export const CATEGORY_NAMES = Object.keys(CATEGORIES) as [Category, ...Category[]];

export const REGIONS = {
  central: { id: 17, title: 'Central' },
  north_east: { id: 18, title: 'North East' },
  north_west: { id: 21, title: 'North West' },
  south_west: { id: 23, title: 'South West' },
  south_east: { id: 22, title: 'South East' },
  tobago: { id: 15, title: 'Tobago' },
} as const;
export type Region = keyof typeof REGIONS;
export const REGION_NAMES = Object.keys(REGIONS) as [Region, ...Region[]];

export const CURRENCIES = { TTD: 1 } as const;
export type Currency = keyof typeof CURRENCIES;

/** Pin's paid placement rules (prod, per Pin): used only to warn agencies in advance. */
export const PAID_RULES = {
  residential_sale:
    'Paid placement (69.00 TT$ / 30 days) after the first 5 free listings per 30 days.',
  residential_rent:
    'Paid placement (69.00 TT$ / 30 days) for rent above 4000 TT$ after 4 free such listings per 30 days.',
} as const;

export const RENT_PAID_THRESHOLD = 4000;
export const MAX_PIN_IMAGES = 16;
