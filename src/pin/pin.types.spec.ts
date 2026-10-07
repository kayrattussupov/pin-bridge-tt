import { describe, expect, it } from 'vitest';
import { pinItemListSchema, pinItemSchema } from './pin.types';

// Copied from prod front_my (2026-10-07).
const frontMyItem = {
  id: 654824,
  status: {
    status: ['Pending for review', 'Active until 06.11.2026,&nbsp;07:16'],
    comment: '',
    comment_name: '',
    meter: 0,
    code: 'status_check',
    top_meter: 0,
    published_before: '',
  },
  not_paid: null,
};

describe('pinItemSchema status', () => {
  it('reads a numeric status (POST /items/)', () => {
    expect(pinItemSchema.parse({ id: 1, status: 1 }).status).toBe(1);
  });

  it('maps the front_my status object by its code', () => {
    const item = pinItemSchema.parse(frontMyItem);
    expect(item).toMatchObject({ status: 1, status_code: 'status_check', not_paid: null });
    expect(item.moderator_comment).toBeNull();
  });

  it('takes the moderator comment from the status object', () => {
    const item = pinItemSchema.parse({
      id: 1,
      status: { code: 'rejected', comment: 'Photos do not match' },
    });
    expect(item).toMatchObject({ status: 3, moderator_comment: 'Photos do not match' });
  });

  it('leaves unknown or missing statuses undefined instead of failing the page', () => {
    const page = pinItemListSchema.parse({
      results: [
        { id: 1, status: { code: 'something_new' } },
        { id: 2, status: 9 },
        { id: 3 },
        frontMyItem,
      ],
    });
    expect(page.results.map((item) => item.status)).toEqual([undefined, undefined, undefined, 1]);
    expect(page.results[0]).toMatchObject({ status_code: 'something_new' });
  });
});
