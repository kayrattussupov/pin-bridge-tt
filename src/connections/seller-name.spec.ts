import { describe, expect, it } from 'vitest';
import { sellerNameOf } from './seller-name';

const connection = (pinLegalName: string | null, pinName: string | null) => ({
  displayName: 'Duck Agency',
  pinLegalName,
  pinName,
});

describe('sellerNameOf', () => {
  it('prefers the legal name of the Pin account', () => {
    expect(sellerNameOf(connection('Darcell Taylor', 'Illia'))).toBe('Darcell Taylor');
  });

  it('falls back to the Pin display name, then to the name given at connecting', () => {
    expect(sellerNameOf(connection(null, 'Illia'))).toBe('Illia');
    expect(sellerNameOf(connection(null, null))).toBe('Duck Agency');
  });

  it('treats empty strings like missing names', () => {
    expect(sellerNameOf(connection('', ''))).toBe('Duck Agency');
  });
});
