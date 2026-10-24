/** Field names whose values are credentials, wherever they appear in a Pin answer. */
const SECRET_FIELD = /token|api[-_]?key|secret|password|authorization/i;

export const REDACTED = '[REDACTED]';

/** A copy of `value` with every credential-like field replaced by `[REDACTED]`. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SECRET_FIELD.test(key) && v !== null && v !== '' ? REDACTED : redactSecrets(v),
      ]),
    );
  }
  return value;
}
