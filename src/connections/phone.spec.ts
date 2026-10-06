import { describe, expect, it } from 'vitest';
import { normalizeTtPhone } from './phone';

describe('normalizeTtPhone', () => {
  it.each([
    '+1 868 723 4567',
    '+18687234567',
    '1-868-723-4567',
    '(868) 723-4567',
    '8687234567',
    '723-4567',
    '868.723.4567',
  ])('normalizes %s', (input) => {
    expect(normalizeTtPhone(input)).toBe('+18687234567');
  });

  it.each([
    '+7 701 123 4567', // Kazakhstan, Pin refuses it
    '+1 212 555 0100', // US
    '868 023 4567', // subscriber numbers cannot start with 0 or 1 (NANP)
    '868 123 4567',
    '12345',
    '+1868123456789',
    'call me',
    '',
  ])('rejects %s', (input) => {
    expect(normalizeTtPhone(input)).toBeUndefined();
  });
});
