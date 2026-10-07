/**
 * Adapter for Pin's `GET /items/rubric_form/<id>/`.
 *
 * Production (seen 2026-10-07): `{ id, name, rubric_features: [{ feature_name: "attrs__bedrooms",
 * feature_verbose_name, feature_type: "Integer choices", feature_choices: [{ key: "10", value: "3" }],
 * required, geo }] }`. The `attrs__` prefix is dropped (the slug is the key inside `attrs`), numeric
 * choice keys become numbers, and the geo field is skipped (coordinates are sent separately).
 * Other plausible shapes (`fields`/`variants`/`choices`, root array) are still accepted. If Pin
 * changes the format, only this file needs to change: run `admin.js dict:show --kind rubric_form
 * --key 21` on the server to see the raw response.
 */

export interface AttributeVariant {
  /** What goes into `attrs` for Pin. */
  key: number | string;
  /** What a human sees, e.g. "3" for bedrooms or "Apartment". */
  label: string;
}

export interface AttributeField {
  slug: string;
  title: string;
  required: boolean;
  kind: 'select' | 'multiselect' | 'number' | 'text';
  variants: AttributeVariant[];
}

export interface RubricForm {
  rubric: number;
  fields: AttributeField[];
}

export class RubricFormParseError extends Error {}

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;

const firstDefined = (raw: Raw, keys: string[]): unknown => {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) {
      return raw[key];
    }
  }
  return undefined;
};

const NUMERIC_TYPES = new Set(['number', 'numeric', 'int', 'integer', 'float', 'decimal', 'range']);
const MULTI_TYPES = new Set(['multiselect', 'multi', 'multiple', 'checkbox', 'checkboxes']);
const TEXT_TYPES = new Set(['text', 'string', 'textarea', 'input']);

function fieldList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  for (const key of [
    'rubric_features',
    'fields',
    'features',
    'attrs',
    'attributes',
    'form',
    'results',
    'data',
    'result',
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
    const nested = asRecord(value);
    if (nested) {
      const inner = fieldList(nested);
      if (inner.length) {
        return inner;
      }
    }
  }
  return [];
}

function parseVariant(raw: unknown): AttributeVariant | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const hasExplicitKey = record.key !== undefined || record.id !== undefined;
  const key = firstDefined(record, ['key', 'id', 'value']);
  const label = hasExplicitKey
    ? firstDefined(record, ['value', 'name', 'title', 'label'])
    : firstDefined(record, ['name', 'title', 'label', 'value']);
  if ((typeof key !== 'number' && typeof key !== 'string') || label === undefined) {
    return undefined;
  }
  // Pin sends "Integer choices" keys as strings ("10"); its attrs take them as integers.
  return {
    key: typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : key,
    label: String(label),
  };
}

function parseField(raw: unknown): AttributeField | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const rawSlug = firstDefined(record, ['slug', 'key', 'feature_name', 'name', 'code']);
  const slug = typeof rawSlug === 'string' ? rawSlug.replace(/^attrs__/, '') : '';
  if (!slug) {
    return undefined;
  }
  const type = String(
    firstDefined(record, ['type', 'feature_type', 'widget', 'input_type', 'kind']) ?? '',
  ).toLowerCase();
  if (record.geo === true || type === 'geo') {
    return undefined;
  }
  const title = String(
    firstDefined(record, ['title', 'label', 'feature_verbose_name', 'name']) ?? slug,
  );
  const required = Boolean(
    firstDefined(record, ['required', 'is_required', 'obligatory', 'mandatory']),
  );
  const rawVariants = firstDefined(record, [
    'variants',
    'feature_choices',
    'choices',
    'values',
    'options',
    'items',
  ]);
  const variants = Array.isArray(rawVariants)
    ? rawVariants.map(parseVariant).filter((v): v is AttributeVariant => Boolean(v))
    : [];
  const multiple =
    Boolean(firstDefined(record, ['multiple', 'is_multiple', 'multi'])) ||
    MULTI_TYPES.has(type) ||
    // Prod: "Integer multi choices".
    /\bmulti/.test(type);
  const numeric =
    Boolean(firstDefined(record, ['numeric', 'is_numeric'])) || NUMERIC_TYPES.has(type);

  let kind: AttributeField['kind'];
  if (variants.length > 0) {
    kind = multiple ? 'multiselect' : 'select';
  } else if (numeric) {
    kind = 'number';
  } else if (TEXT_TYPES.has(type)) {
    kind = 'text';
  } else {
    kind = 'number';
  }
  return { slug, title, required, kind, variants };
}

export function parseRubricForm(rubric: number, raw: unknown): RubricForm {
  const fields = fieldList(raw)
    .map(parseField)
    .filter((f): f is AttributeField => Boolean(f));
  if (fields.length === 0) {
    throw new RubricFormParseError(`rubric_form ${rubric}: no attribute fields recognized`);
  }
  return { rubric, fields };
}
