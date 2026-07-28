import { mkdir, readFile } from 'node:fs/promises';
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
  const banner = page.getByRole('banner');
  await expect(banner.getByText('仅本机访问', { exact: true })).toBeVisible();
  await expect(banner.getByRole('status')).toHaveText('运行正常');
  await expect(page.getByRole('heading', { name: '下一步：创建第一件关注' })).toBeVisible();
  await page.screenshot({ path: screenshotPath('now-empty-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '创建关注任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新增一件关注' })).toBeVisible();
  for (const groupName of ['关注对象', '匹配条件', '目标就诊日期与时段']) {
    await expect(page.getByRole('group', { name: groupName, exact: true })).toBeVisible();
  }
  const reminderContract = page.getByRole('region', {
    name: '这项提醒会怎样工作',
    exact: true,
  });
  await expect(reminderContract).toBeVisible();
  await expect(reminderContract).toContainText('首次检查只建立 baseline，不会补发已有排班');

  const hospitalSelect = page.getByRole('combobox', { name: '医院', exact: true });
  await expect(hospitalSelect.getByRole('option')).toHaveCount(11);
  await hospitalSelect.selectOption('hospital-jishuitan');
  await expect(page.getByText('暂不支持提醒', { exact: true })).toBeVisible();
  await expect(reminderContract).toContainText('当前不会开始检查或发送提醒');
  await expect(page.getByRole('button', { name: '创建并开始关注', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', {
    name: '打开北京积水潭医院官网（不是预约入口 ，新标签页打开 ）',
    exact: true,
  })).toHaveAttribute('href', 'https://www.jst-hosp.com.cn/');

  await hospitalSelect.selectOption('hospital-pumch');
  await page.getByRole('textbox', { name: '开始日期', exact: true }).fill(futureDate(1));
  await page.getByRole('textbox', { name: '结束日期', exact: true }).fill(futureDate(7));
  await page.getByRole('combobox', { name: '时段', exact: true }).selectOption('AM');
  await page.getByRole('button', { name: '创建并开始关注', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科', exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: '关注任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你正在关注的事' })).toBeVisible();

  await page.getByRole('link', { name: '规则与日历', exact: true }).click();
  await expect(page.getByRole('heading', { name: '什么时候值得看', exact: true })).toBeVisible();
  await expect(page.getByRole('link', {
    name: '查看医院规则说明 （新标签页打开）',
    exact: true,
  })).toBeVisible();
  const ruleSupplements = page.getByRole('region', { name: '医院说明补充', exact: true });
  for (let index = 0; index < await ruleSupplements.count(); index += 1) {
    await expect(ruleSupplements.nth(index)).toContainText('未据此推算常规放号');
    await expect(ruleSupplements.nth(index)).toContainText('实际提醒按任务设置提前发送');
  }
  await page.screenshot({ path: screenshotPath('rules-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '数据来源', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^\d+ 个科室可创建提醒$/ })).toBeVisible();
  const sourceSummary = page.getByRole('region', { name: '来源能力数量', exact: true });
  await expect(sourceSummary.getByText('可创建提醒', { exact: true })).toBeVisible();
  const jishuitanDirectoryTarget = page.getByRole('heading', {
    name: '北京积水潭医院 · 新街口 · 创伤骨科',
    exact: true,
  });
  await expect(jishuitanDirectoryTarget).toHaveCount(0);
  const showDirectoryTargets = page.getByRole('button', {
    name: /^显示其余 \d+ 个目录或暂不可用目标$/,
  });
  await expect(showDirectoryTargets).toHaveAttribute('aria-expanded', 'false');
  await showDirectoryTargets.click();
  await expect(page.getByRole('button', {
    name: '收起目录或暂不可用目标',
    exact: true,
  })).toHaveAttribute('aria-expanded', 'true');
  await expect(jishuitanDirectoryTarget).toBeVisible();
  const jishuitanDirectoryRow = page.getByRole('article').filter({
    has: jishuitanDirectoryTarget,
  });
  await expect(jishuitanDirectoryRow.getByText('暂不支持提醒', { exact: true })).toBeVisible();

  const pumchProbe = page.getByRole('button', {
    name: '立即检查并记录北京协和医院东单院区皮肤科的新变化',
    exact: true,
  });
  await expect(pumchProbe).toBeVisible();
  await expect(pumchProbe).toHaveText('立即检查并记录新变化');
  // 只确认正式 adapter manifest 已装配，不点击来源检查，避免测试主动发起外站读取。
  await page.screenshot({ path: screenshotPath('sources-1280.png'), fullPage: true });

  await page.getByRole('link', { name: '本机设置', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '先确认这台电脑已经准备好' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^发送 .+ 测试通知$/ })).toHaveCount(0);
  const recheckRegion = page.getByRole('region', { name: '重新检查本机状态', exact: true });
  await recheckRegion.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(recheckRegion.getByRole('status', { name: /^检查完成：.+（北京时间）$/ }))
    .toBeVisible();
  await page.screenshot({ path: screenshotPath('settings-1280.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('link', { name: '现在', exact: true }).click();
  await expect(page.getByRole('heading', { name: '下一步：核对最近规则' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: '主要导航，六个入口', exact: true });
  const navigationLabels = ['现在', '关注任务', '规则与日历', '通知记录', '数据来源', '本机设置'];
  await expect(navigation.getByRole('link')).toHaveCount(navigationLabels.length);
  for (const label of navigationLabels) {
    const link = navigation.getByRole('link', { name: label, exact: true });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    if (!box) throw new Error(`${label} 导航入口没有可见边界`);
    expect(box.x, `${label} 导航入口应位于 375px 视口内`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label} 导航入口应位于 375px 视口内`).toBeLessThanOrEqual(375);
  }
  const pageWidths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(Math.max(pageWidths.document, pageWidths.body)).toBeLessThanOrEqual(pageWidths.viewport);
  await page.screenshot({ path: screenshotPath('now-with-task-375.png'), fullPage: true });

  expect(pageErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test('E2E 装配精确 PUMCH binding，同时禁止服务器真实外联与通知配对', async ({ request }, testInfo) => {
  // 正式来源 manifest 必须装配，才能覆盖 B2 的精确 runtime binding 准入；真实通知
  // 凭据仍全部置空，服务器 fetch 则由 server-guard.mjs 限定为 loopback-only。
  const response = await request.get('/api/runtime-status');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    notifications: Array<{ key: string; enabled: boolean; reason: string | null }>;
    browserAgent: { configured: boolean };
    sourceCapabilities: Array<{
      key: string;
      sourceId?: string | null;
      enabled: boolean;
      stability?: string | null;
      bindings?: Array<{
        targetId: string;
        hospitalId: string;
        campusId: string;
        departmentId: string;
      }>;
    }>;
  };
  expect(body.notifications.length).toBeGreaterThan(0);
  for (const channel of body.notifications) {
    expect(channel.enabled, `E2E 中通知渠道 ${channel.key} 必须禁用`).toBe(false);
    expect(channel.reason, `E2E 中通知渠道 ${channel.key} 必须给出禁用原因`).not.toBeNull();
  }
  expect(body.browserAgent.configured).toBe(false);

  const pumchSource = body.sourceCapabilities.find(
    (source) => source.key === 'pumch-public-dermatology-schedule',
  );
  expect(pumchSource).toMatchObject({
    sourceId: 'source-pumch-public-schedule',
    enabled: true,
    stability: 'stable',
    bindings: [
      {
        targetId: 'target-pumch-dermatology',
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
      },
    ],
  });

  const guardStateFile = testInfo.config.metadata.e2eServerGuardStateFile;
  expect(typeof guardStateFile).toBe('string');
  if (typeof guardStateFile !== 'string') throw new Error('缺少 E2E server guard 状态文件路径');
  type GuardState = {
    policy: string;
    passedThroughNonLoopbackFetches: number;
    blockedNonLoopbackFetches: number;
  };
  const readGuardState = async (): Promise<GuardState> =>
    JSON.parse(await readFile(guardStateFile, 'utf8')) as GuardState;

  // 首个流程创建 PUMCH 任务后会触发后台来源检查。等待守卫确实在原始 fetch 前
  // 捕获该非 loopback 尝试，再确认没有任何非 loopback 请求被放行。
  await expect.poll(async () => (await readGuardState()).blockedNonLoopbackFetches).toBeGreaterThan(0);
  const guardState = await readGuardState();
  expect(guardState.policy).toBe('loopback-only');
  expect(guardState.passedThroughNonLoopbackFetches).toBe(0);
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

test('rules-only 任务显示规则提醒语义，public-source 任务保持排班关注语义', async ({ page }) => {
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

  // 加入公开排班任务后：列表与首页只使用排班关注语义，不扩大为实时号源监控
  await createWatchTask(page, {
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
  });
  await page.goto('/tasks');
  const aRow = page.locator('article').filter({ hasText: '北京协和医院' });
  await expect(aRow.getByText('公开来源支持已启用')).toBeVisible();

  await page.goto('/');
  await expect(
    page.getByText('公开排班关注正在运行，目前没有新的变化事件。可以核对来源状态和最后成功时间。'),
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
