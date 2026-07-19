const ALLOWED_HOSTS = new Set(['www.pumch.cn', 'pumchapp.pumch.cn']);
const MAX_RENDER_MS = 20_000;

export const getPumchRenderStepTimeout = (
  deadlineAt: string,
  nowMs = Date.now(),
): number => {
  const remainingMs = Date.parse(deadlineAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error('PUMCH_RENDER_DEADLINE_EXCEEDED');
  }
  return Math.min(MAX_RENDER_MS, remainingMs);
};

const withRemainingDeadline = async <T>(
  deadlineAt: string,
  operation: (timeoutMs: number) => Promise<T>,
): Promise<T> => {
  const timeoutMs = getPumchRenderStepTimeout(deadlineAt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(timeoutMs),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('PUMCH_RENDER_DEADLINE_EXCEEDED')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const assertAllowedUrl = (value: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('PUMCH_RENDER_URL_NOT_ALLOWED');
  }
};

export async function renderPumchSchedulePage(
  url: string,
  deadlineAt: string,
): Promise<string> {
  assertAllowedUrl(url);
  getPumchRenderStepTimeout(deadlineAt);

  const { chromium } = await import('playwright');
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await withRemainingDeadline(deadlineAt, (timeoutMs) =>
      chromium.launch({ headless: true, timeout: timeoutMs }),
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) {
      throw error;
    }
    browser = await withRemainingDeadline(deadlineAt, (timeoutMs) =>
      chromium.launch({ channel: 'chrome', headless: true, timeout: timeoutMs }),
    );
  }

  try {
    const context = await withRemainingDeadline(deadlineAt, () => browser.newContext());
    await context.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();

      try {
        assertAllowedUrl(request.url());
      } catch {
        await route.abort('blockedbyclient');
        return;
      }

      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
        await route.abort('blockedbyclient');
        return;
      }

      await route.continue();
    });

    const page = await withRemainingDeadline(deadlineAt, () => context.newPage());
    await withRemainingDeadline(deadlineAt, (timeoutMs) =>
      page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }),
    );
    assertAllowedUrl(page.url());

    try {
      await withRemainingDeadline(deadlineAt, (timeoutMs) =>
        page
          .locator('#docker-visit .visitinfo')
          .waitFor({ state: 'attached', timeout: Math.max(1, timeoutMs) }),
      );
    } catch {
      getPumchRenderStepTimeout(deadlineAt);
    }

    return await withRemainingDeadline(deadlineAt, () => page.content());
  } finally {
    await browser.close();
  }
}
