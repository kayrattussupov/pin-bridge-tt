/**
 * Adapter for Pin's `GET /items/rubric_form/<id>/`.
 *
 * Pin has published no schema for this response, so this parser accepts the plausible shapes of
 * the platform (fields under `fields`/`features`/`attrs`/`form`/root array; variants under
 * `variants`/`choices`/`values`/`options`; ids under `key`/`id`/`value`). If production returns
 * something else, only this file needs to change: run `admin.js dict:show --kind rubric_form
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
  return { key, label: String(label) };
}

function parseField(raw: unknown): AttributeField | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const slug = firstDefined(record, ['slug', 'key', 'name', 'code']);
  if (typeof slug !== 'string' || !slug) {
    return undefined;
  }
  const title = String(firstDefined(record, ['title', 'label', 'name']) ?? slug);
  const required = Boolean(
    firstDefined(record, ['required', 'is_required', 'obligatory', 'mandatory']),
  );
  const rawVariants = firstDefined(record, ['variants', 'choices', 'values', 'options', 'items']);
  const variants = Array.isArray(rawVariants)
    ? rawVariants.map(parseVariant).filter((v): v is AttributeVariant => Boolean(v))
    : [];
  const type = String(
    firstDefined(record, ['type', 'widget', 'input_type', 'kind']) ?? '',
  ).toLowerCase();
  const multiple =
    Boolean(firstDefined(record, ['multiple', 'is_multiple', 'multi'])) || MULTI_TYPES.has(type);
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
