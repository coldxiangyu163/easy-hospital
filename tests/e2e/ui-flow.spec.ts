import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

function futureDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function clearWatchTasks(page: Page): Promise<void> {
  const response = await page.request.get('/api/watch-tasks');
  const { tasks } = (await response.json()) as { tasks: Array<{ id: string }> };
  for (const task of tasks) {
    await page.request.delete(`/api/watch-tasks/${task.id}`);
  }
}

async function createWatchTask(
  page: Page,
  target: { hospitalId: string; campusId: string; departmentId: string },
): Promise<void> {
  const response = await page.request.post('/api/watch-tasks', {
    data: {
      ...target,
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      dateFrom: futureDate(1),
      dateTo: futureDate(7),
      session: 'ANY',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: 5,
    },
  });
  if (!response.ok()) throw new Error(`创建任务失败：${response.status()}`);
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

test('E2E 服务器未装配任何真实通知渠道与 Browser Agent 配对', async ({ request }) => {
  // 可验证断言：webServer 环境变量置空 + server-guard.mjs 必须让三条通知渠道全部
  // 处于禁用态。任何一条防线失效（例如本机 .env 中的真实凭据上膛）都会让此用例变红。
  const response = await request.get('/api/runtime-status');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    notifications: Array<{ key: string; enabled: boolean; reason: string | null }>;
    browserAgent: { configured: boolean };
  };
  expect(body.notifications.length).toBeGreaterThan(0);
  for (const channel of body.notifications) {
    expect(channel.enabled, `E2E 中通知渠道 ${channel.key} 必须禁用`).toBe(false);
    expect(channel.reason, `E2E 中通知渠道 ${channel.key} 必须给出禁用原因`).not.toBeNull();
  }
  expect(body.browserAgent.configured).toBe(false);
});

test('首次 Tab 落在「跳到主要内容」，激活后焦点进入主区域', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // 回归：scrollIntoView 曾移动顺序焦点起点，导致首 Tab 跳到当前导航项的下一项
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  // SPA 导航后焦点仍应进入主区域
  await page.getByRole('link', { name: '规则与日历', exact: true }).click();
  await expect(page.locator('#main-content')).toBeFocused();
});

test('C 级任务显示规则提醒语义，A 级任务保持监控语义', async ({ page }) => {
  await clearWatchTasks(page);
  await page.goto('/');

  // 纯 C 级：列表徽章与首页首屏都不得出现“监控”
  await createWatchTask(page, {
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
  });
  await page.goto('/tasks');
  const cRow = page.locator('article').filter({ hasText: '北京同仁医院' });
  await expect(cRow.getByText('规则提醒已启用')).toBeVisible();
  await expect(cRow.getByText('监控中')).toHaveCount(0);

  await page.goto('/');
  await expect(
    page.getByText('规则提醒运行中，目前没有新的变化事件。可以核对放号时间和最后核验日期。'),
  ).toBeVisible();

  // 加入 A 级任务后：A 行保持“监控中”，首页恢复监控语义
  await createWatchTask(page, {
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
  });
  await page.goto('/tasks');
  const aRow = page.locator('article').filter({ hasText: '北京协和医院' });
  await expect(aRow.getByText('监控中')).toBeVisible();

  await page.goto('/');
  await expect(
    page.getByText('监控正在运行，目前没有新的变化事件。可以核对放号时间和最后核验日期。'),
  ).toBeVisible();
});

test('浅绿底说明文字对比度达到 WCAG AA（≥4.5:1）', async ({ page }) => {
  const contrastOf = (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const luminance = (rgb: string): number => {
        const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = luminance(getComputedStyle(el).color);
      let node: HTMLElement | null = el;
      let bg = '';
      while (node) {
        const candidate = getComputedStyle(node).backgroundColor;
        if (candidate !== 'transparent' && !/^rgba\(0, 0, 0, 0\)$/.test(candidate)) {
          bg = candidate;
          break;
        }
        node = node.parentElement;
      }
      const bgL = luminance(bg);
      return (Math.max(fg, bgL) + 0.05) / (Math.min(fg, bgL) + 0.05);
    });

  await page.goto('/tasks/new');
  await expect(page.getByRole('heading', { name: '新增一件关注' })).toBeVisible();
  expect(await contrastOf('[class*="policyNote"] p')).toBeGreaterThanOrEqual(4.5);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '先确认这台电脑已经准备好' })).toBeVisible();
  expect(
    await contrastOf('[class*="setupSummaryGood"] span, [class*="setupSummaryWarning"] span'),
  ).toBeGreaterThanOrEqual(4.5);
});

test('删除对话框打开时背景 inert，焦点困在对话框内，关闭后焦点恢复', async ({ page }) => {
  await clearWatchTasks(page);
  await createWatchTask(page, {
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
  });

  await page.goto('/tasks');
  const deleteButton = page.getByRole('button', { name: /删除关注 北京协和医院/ });
  await deleteButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#app-shell')).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: '保留任务' })).toBeFocused();

  // 焦点陷阱：Tab 在「保留任务」「确认删除」之间循环
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '确认删除' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '保留任务' })).toBeFocused();

  // Esc 关闭：inert 移除、焦点回到触发按钮
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#app-shell')).not.toHaveAttribute('inert', '');
  await expect(deleteButton).toBeFocused();
});
