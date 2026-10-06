import { describe, expect, it } from 'vitest';
import { SLUG_PATTERN } from '../agencies/agencies.service';
import { slugCandidates, slugFromName } from './slug';

describe('slugFromName', () => {
  it('turns names into pattern-compatible slugs', () => {
    expect(slugFromName('Duck Realty Ltd.')).toBe('duck-realty-ltd');
    expect(slugFromName('  Café  Résidences ')).toBe('cafe-residences');
    expect(slugFromName('A very long agency name that goes on and on')).toMatch(SLUG_PATTERN);
  });

  it('falls back when nothing usable is left', () => {
    expect(slugFromName('!!!')).toBe('agency');
    expect(slugFromName('Ж')).toBe('agency');
    expect(slugFromName('x')).toBe('agency');
  });
});

describe('slugCandidates', () => {
  it('appends a counter and stays within the pattern', () => {
    const base = 'a'.repeat(31);
    const list = [...slugCandidates(base, 12)];
    expect(list[0]).toBe(base);
    expect(list[1]).toBe(`${'a'.repeat(29)}-2`);
    expect(list[10]).toBe(`${'a'.repeat(28)}-11`);
    for (const slug of list) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });
});
