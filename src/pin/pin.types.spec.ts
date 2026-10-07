import { describe, expect, it } from 'vitest';
import { pinItemListSchema, pinItemSchema } from './pin.types';

describe('pinItemSchema status', () => {
  it('reads a numeric status', () => {
    expect(pinItemSchema.parse({ id: 1, status: 1 }).status).toBe(1);
  });

  it('reads the code out of an object status (front_my on prod)', () => {
    expect(pinItemSchema.parse({ id: 1, status: { id: 0, name: 'Published' } }).status).toBe(0);
    expect(pinItemSchema.parse({ id: 1, status: { value: '3' } }).status).toBe(3);
  });

  it('leaves an unrecognised status undefined instead of failing the page', () => {
    const page = pinItemListSchema.parse({
      results: [
        { id: 1, status: { name: 'Strange' } },
        { id: 2, status: 9 },
        { id: 3, status: 2 },
        { id: 4 },
      ],
    });
    expect(page.results.map((item) => item.status)).toEqual([undefined, undefined, 2, undefined]);
  });
});
