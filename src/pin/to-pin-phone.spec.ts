import { describe, expect, it } from 'vitest';
import { toPinPhone } from './pin.client';

describe('toPinPhone', () => {
  it('sends a TT number in the format verified against prod', () => {
    expect(toPinPhone('+18686813498')).toBe('+1 868 681 3498');
  });

  it('passes anything else through unchanged', () => {
    expect(toPinPhone('+1 868 681 3498')).toBe('+1 868 681 3498');
    expect(toPinPhone('+77011234567')).toBe('+77011234567');
  });
});
