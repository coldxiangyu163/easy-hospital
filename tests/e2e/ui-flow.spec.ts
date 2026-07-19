import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test('创建关注并浏览规则、来源与本机设置，无 pageerror 和真实外网请求', async ({ page }, testInfo) => {
  const screenshotDirectory =
    process.env.UPDATE_UI_ARTIFACTS === '1' ? 'artifacts/ui' : testInfo.outputDir;
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = (name: string): string => join(screenshotDirectory, name);
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push(url.href);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '下一步：创建第一件关注' })).toBeVisible();
  await page.screenshot({ path: screenshotPath('now-empty-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '创建关注任务' }).click();
  await expect(page.getByRole('heading', { name: '新增一件关注' })).toBeVisible();
  await page.getByLabel('开始日期').fill(futureDate(1));
  await page.getByLabel('结束日期').fill(futureDate(7));
  await page.getByLabel('时段').selectOption('AM');
  await page.getByRole('button', { name: '创建并开始关注' }).click();
  await expect(
    page.getByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' }),
  ).toBeVisible();

  await page.getByRole('link', { name: '关注任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你正在关注的事' })).toBeVisible();

  await page.getByRole('link', { name: '规则与日历', exact: true }).click();
  await expect(page.getByRole('heading', { name: /什么时候值得看|还没有已记录的放号规则/ })).toBeVisible();
  await page.screenshot({ path: screenshotPath('rules-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '数据来源', exact: true }).click();
  await expect(page.getByRole('heading', { name: '数据从哪里来' })).toBeVisible();
  await expect(page.getByRole('button', { name: '运行 A 级来源自检' })).toHaveCount(0);
  await page.screenshot({ path: screenshotPath('sources-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '本机设置', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '先确认这台电脑已经准备好' }),
  ).toBeVisible();
  await page.screenshot({ path: screenshotPath('settings-1280.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('link', { name: '现在', exact: true }).click();
  await expect(page.getByRole('heading', { name: '下一步：核对最近规则' })).toBeVisible();
  await page.screenshot({ path: screenshotPath('now-with-task-375.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});
