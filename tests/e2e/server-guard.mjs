// E2E 服务器防护，由 playwright.config.ts 的 webServer 以 --import 注入，只作用于被测
// 服务器进程本身（不影响 tsc/vite 等构建步骤——platform 伪装会让 rollup 找不到本机原生
// 绑定，因此绝不能通过 NODE_OPTIONS 传播到 npm start 的 prestart）。
//
// 两道防线：
// 1) 把 process.platform 伪装成非 darwin，使 macOS 通知渠道走既有 fail-closed 分支
//    （disabledReason=unsupported_platform）。这是不改动 src 前提下唯一可靠的禁用点：
//    该渠道只认 process.platform 与 /usr/bin/osascript 绝对路径，不读任何环境变量。
// 2) 拦截服务器进程内 fetch：仅放行 loopback，其余在调用原始 fetch 前一律熔断。
//    E2E 会有意装配正式来源 adapter manifest，以覆盖精确 runtime binding 准入；装配
//    manifest 不等于允许外联。守卫状态文件记录放行/阻断计数，供测试确认策略已生效。
// 注意：SMTP 走裸 TCP（nodemailer），不经过 fetch，必须由 webServer.env 置空 SMTP_* 兜底。
// 配套验证：tests/e2e/ui-flow.spec.ts 会同时断言通知渠道禁用、PUMCH binding 已装配，
// 以及服务器传给原始 fetch 的非 loopback 请求数始终为 0。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

Object.defineProperty(process, 'platform', { value: 'linux' });

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const originalFetch = globalThis.fetch;
const stateFile = process.env.EASY_HOSPITAL_E2E_SERVER_GUARD_STATE_FILE;
const guardState = {
  policy: 'loopback-only',
  passedThroughLoopbackFetches: 0,
  passedThroughNonLoopbackFetches: 0,
  blockedNonLoopbackFetches: 0,
};

function persistGuardState() {
  if (!stateFile) return;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(guardState)}\n`, 'utf8');
}

persistGuardState();

globalThis.fetch = async function guardedFetch(input, init) {
  const rawUrl =
    typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    guardState.blockedNonLoopbackFetches += 1;
    persistGuardState();
    throw new Error(`E2E server guard: 阻断服务器端非本机外联 ${hostname}`);
  }
  guardState.passedThroughLoopbackFetches += 1;
  persistGuardState();
  return originalFetch(input, init);
};
