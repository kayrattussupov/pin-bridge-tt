/**
 * Normalizes a Trinidad and Tobago number to E.164 (+1868XXXXXXX). Pin's phone_verify only
 * accepts TT numbers ("Could not determine the country by number" otherwise), so anything else
 * is rejected before an SMS is attempted.
 *
 * Accepts: +1 868 123 4567, 1-868-123-4567, (868) 123-4567, 8681234567, 123-4567.
 */
export function normalizeTtPhone(input: string): string | undefined {
  if (!/^[\d\s()+.-]{7,24}$/.test(input.trim())) {
    return undefined;
  }
  const digits = input.replace(/\D/g, '');
  let national: string | undefined;
  if (digits.length === 7) {
    national = digits;
  } else if (digits.length === 10 && digits.startsWith('868')) {
    national = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith('1868')) {
    national = digits.slice(4);
  }
  // Subscriber numbers never start with 0 or 1 under the North American Numbering Plan.
  if (!national || /^[01]/.test(national)) {
    return undefined;
  }
  return `+1868${national}`;
}
