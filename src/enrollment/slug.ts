import { SLUG_PATTERN } from '../agencies/agencies.service';

const MAX_SLUG_LENGTH = 31;

/** A SLUG_PATTERN-compatible slug from an agency name: "Duck Realty Ltd." → "duck-realty-ltd". */
export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return SLUG_PATTERN.test(slug) ? slug : 'agency';
}

/** Candidates for a free slug: the base, then base-2, base-3, ... trimmed to fit the pattern. */
export function* slugCandidates(base: string, max = 50): Generator<string> {
  yield base;
  for (let n = 2; n <= max; n++) {
    const suffix = `-${n}`;
    yield `${base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
}
