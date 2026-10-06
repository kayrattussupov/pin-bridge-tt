/** `+18681234567` → `+1868***4567`. Keeps enough to tell numbers apart in logs. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 8) {
    return '***';
  }
  return `+${digits.slice(0, 4)}***${digits.slice(-4)}`;
}
