import { describe, expect, it } from 'vitest';

import { getPumchRenderStepTimeout } from '../../src/adapters/sources/pumch-playwright.js';

describe('PUMCH Playwright remaining deadline', () => {
  it('recomputes and caps each step from the remaining absolute deadline', () => {
    const deadlineAt = '2026-07-19T00:00:30.000Z';

    expect(getPumchRenderStepTimeout(deadlineAt, Date.parse('2026-07-19T00:00:00.000Z'))).toBe(
      20_000,
    );
    expect(getPumchRenderStepTimeout(deadlineAt, Date.parse('2026-07-19T00:00:27.500Z'))).toBe(
      2_500,
    );
    expect(() =>
      getPumchRenderStepTimeout(deadlineAt, Date.parse('2026-07-19T00:00:30.000Z')),
    ).toThrowError('PUMCH_RENDER_DEADLINE_EXCEEDED');
  });
});
