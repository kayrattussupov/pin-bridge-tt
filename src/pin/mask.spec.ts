import { describe, expect, it } from 'vitest';
import { maskPhone } from './mask';

describe('maskPhone', () => {
  it('keeps the country prefix and the last four digits', () => {
    expect(maskPhone('+1 (868) 123-4567')).toBe('+1868***4567');
  });

  it('hides short values entirely', () => {
    expect(maskPhone('12345')).toBe('***');
  });
});
