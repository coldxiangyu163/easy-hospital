# 北京挂号雷达架构提案

> 状态：已按用户决策修订
>
> 产品形态：稳定开源版、单用户、仅本地运行
>
> 目标仓库：GitHub `easy-hospital`
>
> 依据：`docs/source-requirements.md` 及后续用户决策

## 1. 决策摘要

**选择稳定开源版，采用 Node.js + SQLite + 本地 Worker 的零基础设施架构。**

应用以一个本地 Node.js 进程运行：主线程承载 Web/API，一个 `worker_threads` Worker 承载调度、来源检查、状态变化判断和通知投递。两者通过同一个本地 SQLite 数据库协作；SQLite 中的持久 Job、租约、唯一键和 Outbox 取代外部数据库与消息队列。

用户完成一次 `npm ci` 和本地配置后，在仓库根目录执行：

```bash
npm start
```

即可启动全部运行能力。应用固定绑定本机回环地址，不提供云端控制面、远程访问、多用户注册或远程同步。

### 1.1 最新决策的优先级

后续用户决策覆盖 `docs/source-requirements.md` 中原有的交付技术约束：

- 不提供容器化运行方案；
- 不要求独立数据库服务；
- 不要求独立缓存或消息队列服务；
- 不要求用户分别启动 Web、Scheduler、Worker 或 Browser 服务；
- Playwright 只是按需安装的本地浏览器运行库，不是常驻基础设施。

### 1.2 最脆弱的前提

本方案假设至少一个首批目标存在无需登录、允许克制读取且能稳定解释语义的官方公开来源。

如果此前提不成立，系统仍可真实提供规则日历、规则过期提示和放号前通知，但**不能宣称具备实时号源监控或退号检测能力**。架构不会通过逆向私有接口、提高频率、使用代理或上传医院登录态来填补这一缺口。

---

## 2. 三条路线比较与最终选择

| 维度 | 个人私有版 | 稳定开源版 | 本地优先混合版 |
|---|---|---|---|
| 主要目标 | 最快满足一个人的当前目标 | 可审计、可复现安装、版本稳定、社区可维护 | 本地控制面与远程/本机执行平面组合 |
| 典型结构 | 单文件脚本或硬编码页面选择器 | 版本化契约、SQLite migration、适配器测试、跨平台 CI、发布治理 | 本地与远程 Agent 协议、设备配对和同步 |
| 首次实现成本 | 最低 | 中等 | 最高 |
| 长期维护 | 页面变化容易波及全局 | 来源变化隔离，贡献规则清楚 | 还需维护跨设备协议和连接状态 |
| 隐私 | 可全部留在本机，但临时脚本易误存页面或会话 | 默认本地、字段白名单、无遥测、发布前隐私扫描 | 需要额外证明上传与配对过程安全 |
| 对当前目标的适配度 | 快但不稳定 | **最佳；最新用户决策已明确选择** | 仅本地运行时没有建设远程执行平面的收益 |

### 最终选择：稳定开源版

稳定开源不等于先建设插件市场或复杂分布式系统。本项目采用“**稳定的本地核心 + 仓库内审核适配器**”：

- 核心接口版本化；
- 真实适配器随仓库源码构建，不动态执行网络下载的第三方代码；
- 所有发布均从 GitHub `easy-hospital` 的固定提交构建；
- 使用 `package-lock.json`、语义化版本、跨平台 CI、migration 与升级前备份；
- 首个稳定版必须经过真实来源观察和真实通知验收，不能只凭 Fixture 演示发布。

不选择本地优先混合版，是因为最新决策已限定仅本机运行。P1 若引入本机浏览器会话，也由同机 Worker 和浏览器子进程完成，不建立远程 Agent 或上传协议。

---

## 3. 总体架构

```text
                           仅监听 127.0.0.1
┌──────────────┐          HTTP + SSE           ┌────────────────────────┐
│ 用户浏览器    │ ◄──────────────────────────► │ Node.js 主线程          │
│ 本地管理端    │                              │ Fastify API + 静态 Web  │
└──────────────┘                              └───────────┬────────────┘
                                                          │ 短事务
                                                          ▼
                                               ┌────────────────────────┐
                                               │ SQLite（本地文件）      │
                                               │ 事实、Job、事件、Outbox │
                                               └───────────▲────────────┘
                                                          │ 独立连接/WAL
                                         MessageChannel   │
                                               ┌──────────┴─────────────┐
                                               │ 本地 Worker Thread      │
                                               │ Scheduler + Job Runner  │
                                               │ Adapter + Detector      │
                                               │ Notifier                │
                                               └───────┬────────┬───────┘
                                                       │        │
                                      低频 fetch/      │        │ SMTP
                                      按需 Playwright  │        ▼
                                                       │   ┌────────────┐
                                                       ▼   │ 用户邮箱    │
                                               ┌──────────┴───────┐
                                               │ 官方公开来源      │
                                               └──────────────────┘
```

### 3.1 架构风格

采用**本地模块化单体**：

- 一个操作系统进程，避免用户维护多个后台进程；
- 主线程与 Worker Thread 分离，防止来源检查和同步 SQLite 写入阻塞管理端；
- SQLite 是唯一事实源，线程消息只负责唤醒和健康心跳，不承载不可恢复的业务状态；
- Job、事件、通知和去重状态全部持久化，重启后可恢复；
- 所有来源检查发生在用户本机，项目没有自有远程服务。

### 3.2 单进程启动与单实例

`npm start` 启动一个 Node.js 主进程。主进程按顺序：

1. 解析本地数据目录与配置；
2. 获取数据目录单实例锁；
3. 在 migration 前创建数据库备份；
4. 执行未应用的 SQLite migration；
5. 启动本地 Worker Thread；
6. Worker 就绪后启动 Fastify；
7. 输出本地 URL，可选打开系统默认浏览器。

同一数据目录只允许一个实例。单实例锁使用数据目录内的原子锁目录、PID 与心跳文件实现；第二个实例必须在发起任何来源请求前退出。异常退出留下的锁只有在确认原 PID 不存在且心跳已过期后才能回收。

---

## 4. 技术栈

| 层次 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js 24 LTS、TypeScript | Web、Worker、适配器和测试共用语言；受支持版本可由 `.nvmrc` 固定 |
| 包管理 | npm + `package-lock.json` | 满足根目录 `npm ci`、`npm start` 契约，减少额外工具要求 |
| Web/API | Fastify | 本地 HTTP、Schema 校验、静态资源和 SSE 足够；比全栈 SSR 框架更轻 |
| 前端 | React + Vite | 适合高交互本地管理端；生产构建由 Fastify 直接提供静态文件 |
| 输入与契约 | Zod | 表单、HTTP、SQLite JSON 字段、Job payload 和适配器结果使用同一运行时校验 |
| 持久化 | SQLite + `better-sqlite3` + 手写 SQL migration | 无守护进程；事务、唯一键、WAL 和同步接口适合单用户本地应用 |
| 后台执行 | `node:worker_threads` | 同一操作系统进程内隔离 Scheduler/Job Runner，满足一条命令启动 |
| 网络 | Node.js 内置 `fetch` 优先 | 静态公开页面或 JSON 来源不需要浏览器 |
| 动态页面 | Playwright Chromium，按 Adapter 能力可选安装 | 只为确需渲染的公开页面和 E2E 使用，不作为强制常驻服务 |
| 通知 | SMTP + Nodemailer | 跨平台、供应商中立；用户可使用自己的邮箱服务，无需项目远程服务 |
| 测试 | Vitest + 临时 SQLite + 真实 Worker Thread + Playwright E2E | CI 无需安装外部数据服务即可覆盖完整本地运行形态 |
| 发布 | GitHub Actions + GitHub Releases | 对目标仓库 `easy-hospital` 做跨平台构建、测试和版本发布 |

### 4.1 SQLite 实现评估

| 方案 | 优点 | 风险 | 结论 |
|---|---|---|---|
| Node.js 24 `node:sqlite` | 无额外数据库驱动依赖，Node 官方维护 | 当前 Node 24 文档仍标为 Stability 1.2（Release candidate），稳定开源版不应把持久化接口押在 RC 接口上 | 暂不采用；进入 Stable 后重新评估 |
| `better-sqlite3` | 成熟、事务清晰、性能适合本地单用户、支持在线备份 | npm 原生扩展，需要验证目标 OS/CPU 的预编译包 | **采用**；通过 GitHub Actions 平台矩阵锁定支持范围 |
| SQLite ORM | 降低部分 CRUD 手写量 | 额外抽象和 migration 规则，事件/Job 的事务 SQL 仍需手写 | 首版不采用；仓储模块隐藏 SQL 即可 |

`better-sqlite3` 是 npm 依赖，不是用户需要安装或维护的外部基础设施。

### 4.2 明确不引入

首版不引入微服务、远程控制面、消息中间件、外部缓存、独立数据库守护进程、动态插件市场、Kubernetes、桌面壳或自动更新器。

---

## 5. 仓库与模块边界

建议保持单 npm package，避免空仓库一开始就建立多 package 发布体系：

```text
src/
  server/                 Fastify、HTTP/SSE、本机访问防护
  worker/                 Worker Thread 入口、调度与 Job Runner
  modules/
    catalog/              医院/院区/科室目录
    release-rules/        放号规则与核验
    watching/             关注任务与匹配
    source-monitoring/    Adapter 运行与健康
    change-detection/     快照比较与领域事件
    notifications/        Outbox、聚合、渠道投递
  adapters/               经仓库审核的真实/Fixture Adapter
  storage/                SQLite 连接、migration、仓储与备份
  security/               URL allowlist、脱敏、CSRF、出网限制
web/                      React 管理端
migrations/               有序、不可变 SQL migration
tests/                    unit/contract/integration/e2e/live
```

### 5.1 模块职责

| 模块 | 职责 | 小接口 | 不负责 |
|---|---|---|---|
| `catalog` | 医院、院区、科室和官方域名目录 | 查询和维护目录 | 访问医院页面 |
| `release-rules` | 规则、引用、可信度、核验时间、下一次放号时刻 | `nextOccurrences(rule, now)` | 发送通知 |
| `watching` | 任务条件、启停、日期和号源匹配 | `match(task, observation)` | 调度来源请求 |
| `source-monitoring` | 注册 Adapter、执行检查、健康状态、脱敏快照 | `check(source, criteria)` | 把失败当作无号 |
| `change-detection` | 比较连续有效快照，生成幂等事件 | `observe(snapshot) -> events` | 调用通知渠道 |
| `scheduling` | 把规则和来源策略变成持久 Job | `plan(now) -> jobs` | 解析来源 |
| `job-runner` | 领取、租约、重试、恢复、终态 | `runDue(now)` | 理解医院业务字段 |
| `notifications` | Outbox、冷却聚合、模板和渠道投递 | `enqueue(event)`、`deliver()` | 再次判断号源 |
| `storage` | SQLite 事务、migration、仓储和备份 | 领域仓储接口 | 包含事件判断规则 |

### 5.2 真实 seam

- `SourceAdapter`：Fixture 与真实来源至少有两个实现；
- `NotificationChannel`：测试 Capture Adapter 与 SMTP Adapter 两个实现；
- `Clock`：生产时钟与可控测试时钟两个实现。

SQLite、Fastify 和 Worker Thread 首版各只有一种实现，不建设无实际替代者的通用插件层。

---

## 6. 数据模型

SQLite 使用外键、`CHECK`、唯一索引和短事务保障一致性。枚举存为受约束的 TEXT，时间统一存 UTC 毫秒整数，界面按 `Asia/Shanghai` 展示。JSON 字段写入前后均通过 Zod Schema 校验。

### 6.1 主要表

| 表 | 关键字段 | 关键约束 |
|---|---|---|
| `hospital` | `id`, `name`, `official_url`, `allowed_hosts_json` | 官方入口和重定向只能命中允许域名 |
| `campus` | `id`, `hospital_id`, `name` | 必须归属医院 |
| `department` | `id`, `hospital_id`, `campus_id`, `name` | 同名科室不跨医院错误合并 |
| `source` | `id`, `adapter_key`, `access_class`, `enabled`, `min_interval_ms`, `health_status`, `last_attempt_at`, `last_success_at`, `failure_count` | `access_class` 仅允许 `A/B/C`；不含凭据字段 |
| `release_rule` | 目录引用、`advance_days`, `release_time_local`, `same_day_policy`, `official_entry_url`, `source_url`, `verified_at`, `confidence` | 超过 30 天标记待确认，超过 90 天降为低可信度 |
| `release_rule_revision` | `rule_id`, `changed_at`, `snapshot_json` | 保存变更后脱敏内容，不保存密钥 |
| `watch_task` | 目录引用、匹配模式、医生/职称、日期范围、时段、`remind_before_minutes`, `enabled`, `version` | 日期不超过未来 14 天；乐观锁防止多标签页覆盖 |
| `watch_task_event_type` | `task_id`, `event_type` | 仅允许三种用户事件类型 |
| `check_run` | `source_id`, `query_fingerprint`, `status`, `started_at`, `finished_at`, `error_code`, `content_hash` | 不保存请求头、原始响应、Cookie、Token、截图或 Trace |
| `availability_snapshot` | `check_run_id`, `observed_at`, `normalized_json`, `content_hash`, `expires_at` | 仅保存契约白名单字段；默认保留 30 天 |
| `availability_state` | `source_id`, `slot_key`, `schedule_status`, `availability`, `first_seen_at`, `last_seen_at`, `changed_at`, `version` | `(source_id, slot_key)` 唯一；`unknown` 不覆盖最近明确状态 |
| `detected_event` | `task_id`, `event_type`, `slot_key`, `from_state`, `to_state`, `evidence`, `detected_at`, `dedupe_key`, `payload_json` | `dedupe_key` 唯一；事件默认保留 90 天 |
| `notification_batch` | `task_id`, `cooldown_key`, `opens_at`, `closes_at`, `status` | 60 秒窗口内的不同事件聚合，不丢弃 |
| `notification_delivery` | `batch_id`, `channel`, `state`, `attempts`, `message_id`, `next_attempt_at`, `last_error_code` | `(batch_id, channel)` 唯一 |
| `job` | `id`, `type`, `payload_json`, `run_at`, `state`, `lease_until`, `attempts`, `max_attempts`, `dedupe_key`, `last_error_code` | `dedupe_key` 唯一；持久调度与崩溃恢复核心 |
| `runtime_session` | `instance_id`, `started_at`, `last_heartbeat_at`, `stopped_at`, `stop_reason` | 用于识别停机和休眠造成的监测空窗 |
| `schema_migration` | `version`, `name`, `checksum`, `applied_at` | 已发布 migration 不允许修改 checksum |

### 6.2 SQLite 运行参数

每个连接启动后设置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

约束：

- 数据库必须位于本机文件系统；不支持 NFS、SMB、网盘同步目录或多个主机共享同一 SQLite 文件；
- 主线程和 Worker 各持有一个连接，所有写事务保持短小；
- 状态更新、DetectedEvent、NotificationBatch 和 Job/Outbox 写入同一事务；
- 启动 migration 前自动创建带版本号的备份；
- 每日使用 SQLite 在线备份能力生成一份本地备份，保留最近 7 份；
- 数据库和备份文件权限限制为当前用户可读写；应用不宣称提供数据库文件加密，依赖操作系统全盘加密保护静态数据。

### 6.3 数据目录

使用操作系统惯例，不把运行数据放在 Git 仓库：

- macOS：`~/Library/Application Support/easy-hospital/`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/easy-hospital/`
- Windows：`%LOCALAPPDATA%\easy-hospital\`

目录包含 SQLite、WAL、备份、锁和脱敏日志；浏览器资料目录与普通数据分开。任何运行数据、配置秘密和真实 Fixture 原文都不能进入 Git。

---

## 7. 本地 Worker 与持久任务调度

### 7.1 为什么不用内存定时器

单纯 `setInterval` 会在程序重启、电脑休眠和进程崩溃时丢失计划，也无法可靠去重。首版使用 SQLite `job` 表作为持久 Job Queue；内存定时器只负责唤醒 Worker 检查到期 Job。

### 7.2 Worker 运行循环

Worker Thread 执行：

1. 每秒领取已到期 Job；
2. 每分钟运行 Planner，物化未来 24 小时的规则提醒和下一轮来源检查；
3. 对过期 `running` 租约执行恢复；
4. 执行 Adapter、状态判断、通知和保留期清理；
5. 每 10 秒写入 Worker 心跳，并向主线程发送轻量健康消息。

Job 领取在 `BEGIN IMMEDIATE` 事务中完成：把一条 `pending` Job 改为 `running`，写入 `lease_until` 和尝试次数后再执行副作用。执行成功进入 `succeeded`；明确不可重试错误进入 `failed`；可重试错误生成新的 `run_at`。

虽然 P0 只有一个 Worker Thread，仍保留租约与幂等键，因为线程可能在写入与外部调用之间崩溃。

### 7.3 调度键

```text
reminder:<task_id>:<rule_id>:<occurrence_at>
check:<source_id>:<query_fingerprint>:<time_bucket>
notify:<batch_id>:<channel>
cleanup:<date>
backup:<date>
```

多个任务命中相同来源和查询范围时，按 `query_fingerprint` 合并为一次检查。Observation 返回后再在本地匹配各任务，不能按任务重复访问医院。

### 7.4 查询频率

与产品决策保持一致：

- 监测时段：每日 06:00～23:00，北京时间；
- 每个来源默认最短 5 分钟一次；
- 同一来源并发固定为 1；
- 多任务复用同一次来源结果；
- 失败后按 5、15、30、60 分钟退避；
- 429 优先遵守 `Retry-After`，且不得早于本地最小间隔；
- 官方规则要求更低频时，以更低频为准；
- 普通配置不能把间隔调到 5 分钟以下。

已知放号时刻不进行高频突发查询。放号前提醒来自本地 ReleaseRule，与来源请求无关。

### 7.5 崩溃、停机与休眠

- Worker Thread 异常退出后，主线程按 1、5、30 秒退避重启；10 分钟内连续 5 次崩溃后停止自动重启并将总健康状态标为失败；
- `Ctrl+C` 后停止领取新 Job，给正在执行的短任务最多 10 秒完成，再关闭 SQLite；
- 上次心跳到本次启动之间记录为监测空窗；
- 空窗恢复后先建立新基线，不推断离线期间发生过放号或退号；
- 过期超过 5 分钟的“放号前提醒”不补发，只记录 `missed`；
- Redis 等外部队列不存在，因此恢复依据只来自 SQLite。

### 7.6 事件规则

首次成功检查只建立基线，不发送状态变化事件。之后：

- `schedule_released`：目标排班在上一次成功快照不存在、本次首次出现；
- `availability_changed_to_available`：同一 `slot_key` 从明确 `unavailable` 变为明确 `available`；
- `cancellation_slot_detected`：已发布排班在最近 30 分钟内从明确 `unavailable` 变为 `available`；文案必须是“疑似退号回流”；
- `unknown` 不覆盖最近明确状态，也不触发变化事件；
- 同一变化若同时满足后两种事件，只生成一个通知批次并展示两个标签。

---

## 8. SourceAdapter 契约

### 8.1 深接口

```ts
interface SourceAdapter {
  readonly manifest: SourceManifest;
  check(request: CheckRequest): Promise<CheckResult>;
}
```

Adapter 的网络客户端、解析器、浏览器生命周期和选择器都隐藏在实现中。调用方只理解版本化输入与结果。

### 8.2 Manifest

`SourceManifest` 至少声明：

- `adapterKey`、`contractVersion`、适配器版本；
- `accessClass: "A" | "B" | "C"`；
- 官方域名和必要静态资源域名白名单；
- 支持的医院、院区、科室与筛选粒度；
- `transport: "fetch" | "playwright" | "rules-only"`；
- 最小查询间隔、超时和是否需要本机人工登录；
- Adapter 当前能产生的事件类型。

### 8.3 请求与结果

`CheckRequest` 只包含公开查询条件：来源、医院、院区、科室、日期、医生/职称、时段、请求截止时间和非敏感游标。不得包含患者身份、医院账号、Cookie、Token 或验证码。

`CheckResult` 通过 Zod 严格解析，至少包含：

- `status`: `OK | PARTIAL | AUTH_REQUIRED | RATE_LIMITED | SOURCE_CHANGED | UNSUPPORTED | TEMPORARY_FAILURE`；
- `observedAt`、`nextAllowedAt` 和脱敏诊断码；
- `observations[]`：稳定 `slotKey`、日期、时段、医生展示名/职称、`scheduleStatus`、`availability`、官方预约入口和证据类型；
- canonical JSON 的 SHA-256 `contentHash`；
- 不包含原始 HTML、完整响应、请求头、截图、Trace、浏览器存储或敏感查询参数。

预期来源错误作为状态返回；只有代码缺陷才抛异常。Adapter 必须通过结构断言区分“合法空号源”和“页面已经改版”。

### 8.4 A/B/C 级执行

- **A 级**：P0。优先使用 `fetch`；公开页面必须渲染时才使用临时、无登录 Playwright Context；
- **B 级**：P1。仍在同一台电脑运行，由 Worker 启动可见 Playwright 浏览器和应用专属持久资料目录，用户人工登录。浏览器子进程只向 Worker 返回规范化结果，Cookie/Token 不写入 SQLite 或日志，也不存在上传行为；
- **C 级**：不运行号源检查，只提供已核验规则和定时提醒。仅微信小程序私有接口可查时必须保持 C 级。

P0 不动态加载第三方 Adapter。社区新增来源通过 GitHub PR 进入 `src/adapters/`，接受代码审查、出网白名单审查、Fixture 脱敏检查和契约测试后随版本发布。

### 8.5 契约测试

每个真实 Adapter 必须覆盖：

- 正常有号、无号、尚未发布；
- 首次基线与无号→有号；
- 页面字段顺序和无关动态内容变化；
- 空响应、登录墙、验证码页、403、429、5xx、超时；
- 页面结构变化返回 `SOURCE_CHANGED`；
- 官方链接白名单与重定向检查；
- 持久化与日志中不出现隐私金丝雀；
- 普通配置无法绕过最小轮询间隔。

---

## 9. 通知

### 9.1 首个真实渠道

首版采用 SMTP 邮件，原因是跨平台且不需要项目维护自有服务。SMTP 不是应用启动的强制条件：未配置时仍可管理规则和查看站内事件，但关注任务只有在真实测试邮件被用户确认收到后才能标记“通知已就绪”。

配置通过本地环境变量注入：

- `EASY_HOSPITAL_SMTP_HOST`
- `EASY_HOSPITAL_SMTP_PORT`
- `EASY_HOSPITAL_SMTP_USER`
- `EASY_HOSPITAL_SMTP_PASSWORD`
- `EASY_HOSPITAL_SMTP_FROM`
- `EASY_HOSPITAL_ALERT_TO`

密钥不进入前端 Bundle、SQLite、日志、诊断导出或 Git 仓库。Web 只显示“已配置/未配置”和脱敏后的渠道标识。

### 9.2 通知内容

通知必须包含：

- 事件类型；退号推断写“疑似退号回流”；
- 医院、院区、科室、日期、时段、医生或职称；
- 检测时间和最近成功时间；
- 来源等级和健康状态；
- 经白名单验证的官方入口；
- “号源可能瞬时变化，请在官方渠道人工完成登录、验证码、实名、医保、确认和付款”的边界说明。

### 9.3 Outbox、聚合与投递语义

状态更新、领域事件和通知批次在同一个 SQLite 事务中写入。任务级 60 秒冷却不是丢弃：窗口内的不同新事件合并成一条通知。

SMTP 不提供通用的服务端幂等键，因此无法同时严格保证“任意崩溃下绝不重复”和“任意崩溃下绝不漏发”。首版明确选择**不自动重复发送状态不确定的邮件**：

1. 投递前把记录提交为 `sending` 并生成稳定 `Message-ID`；
2. SMTP 明确接受后标记 `sent`；
3. 明确在发送前失败时，按 1、5、15 分钟重试，最多 3 次；
4. 连接在发送过程中断开、无法判断服务端是否接受时，标记 `delivery_unknown`，不自动重发，由用户在管理端决定是否手工重试；
5. Worker 重启不会把 `sending` 直接改回 `pending`。

这样能避免程序在崩溃恢复时自动制造重复通知，但存在一封状态不确定邮件可能未送达的诚实代价。未来 Notification Adapter 若支持服务端幂等键，可升级为安全的至少一次重试。

---

## 10. 隐私与安全

### 10.1 本机访问边界

- HTTP 服务固定绑定 `127.0.0.1`，普通配置不能改为局域网或公网地址；
- 不信任 `X-Forwarded-*`，Host 只允许实际本地 Origin，阻止 DNS rebinding；
- CORS 默认关闭；写请求要求同源 `Origin` 和每次启动生成的 CSRF Token；
- 不提供用户注册、登录、远程管理、反向代理或远程访问模式；
- SSE 只向同源页面发送脱敏状态摘要。

仅本地运行不代表可以忽略 Web 安全：恶意网页仍可能尝试向 localhost 提交请求，因此同源与 CSRF 校验必须存在。

### 10.2 数据最小化

医院、科室和医生偏好可能推断健康状况，应按敏感偏好数据处理：

- 不提供医院账号、身份证、医保卡、手机号或验证码录入字段；
- 不保存 Cookie、Token、账号密码、原始页面、网络抓包、截图、Trace 或浏览器存储；
- 日志只记录内部 ID、状态、耗时和脱敏错误码，不打印任务完整条件和通知正文；
- Snapshot 默认保留 30 天，事件和投递记录保留 90 天；
- 默认无遥测、崩溃上报、云同步或项目自有远程服务；
- 对日志、SQLite、Fixture 和测试产物运行隐私金丝雀扫描；
- 诊断导出移除密钥、Cookie、Token、URL 查询参数和用户目录名。

### 10.3 出网与 SSRF

- Adapter 代码内声明允许域名，用户不能输入任意采集 URL；
- 每次重定向都重新校验协议、域名和解析后的 IP；
- 禁止访问 loopback、私网、链路本地地址、云元数据地址、`file:`、`data:` 和 `javascript:`；
- 仅允许医院官方来源、用户配置的通知渠道和用户主动打开的 GitHub 链接；
- A 级 Playwright Context 拦截不在 Manifest 白名单内的导航和请求。

### 10.4 本地文件安全

- 数据、备份、日志和 B 级浏览器资料目录都在仓库外；
- 文件和目录尽量使用当前用户专属权限；
- 通知秘密只从运行环境读取；
- SQLite 不提供应用层加密承诺，README 必须建议启用 FileVault、BitLocker 或 Linux 全盘加密；
- 自动备份不复制 B 级浏览器资料和秘密配置；
- 删除应用数据时分别提示 SQLite 历史、备份和浏览器资料目录的影响。

---

## 11. 本地安装、运行与升级

### 11.1 首次安装

稳定开源版的运行前置仅为：

- Git；
- `.nvmrc` 指定的 Node.js 24 LTS；
- npm；
- 可以访问目标官方来源和通知渠道的本机网络。

标准流程：

```bash
git clone <GitHub 上的 easy-hospital 仓库地址>
cd easy-hospital
npm ci
npm start
```

`npm ci` 根据锁文件安装依赖并构建 TypeScript 与前端静态资源；`npm start` 不要求另开终端。若启用声明 `transport: "playwright"` 的来源，首次配置自检会要求执行仓库提供的 Chromium 安装脚本；未安装时该来源保持不可用，但规则与 `fetch` 来源仍可运行。

### 11.2 健康检查

`/health` 和管理端监控页分别报告：

- 主线程 HTTP 与 SQLite 读写；
- Worker 心跳、最近循环时间和崩溃次数；
- Planner 与 Job Runner 最近成功时间；
- 每个 Adapter 的最后尝试、最后成功、连续失败和下次允许检查时间；
- 通知渠道配置、自检与最近投递；
- 数据目录空间、最近备份和最近 migration；
- 最近一次监测空窗。

健康状态必须区分内部运行失败与单个官方来源失败。一个来源降级不能把整个本地应用伪装成停止，也不能把来源失败显示成“无号”。

### 11.3 升级

1. 正常停止应用；
2. 备份数据目录；
3. 切换到 GitHub Release 对应标签并执行 `npm ci`；
4. `npm start` 自动执行 checksum 校验和向前 migration；
5. migration 成功后启动 Worker 和 Web；
6. 若失败，保留升级前备份并退出，不以部分 schema 启动。

发布后的 migration 不修改、不重排，只追加。首版不承诺数据库降级 migration；回退应用时恢复升级前备份，而不是让旧代码读取新 schema。

### 11.4 GitHub 稳定开源交付

GitHub `easy-hospital` 的稳定版本必须具备：

- 开源许可证、安全报告渠道、贡献指南和变更记录；
- `package-lock.json` 与固定 Node.js 大版本；
- macOS、Ubuntu、Windows 的 GitHub Actions 安装、类型检查、测试和构建矩阵；
- `better-sqlite3` 在声明 CPU/OS 上的安装验证；
- 全新 checkout 后 `npm ci && npm test && npm run build` 可重复通过；
- Release 绑定不可变 Git tag、已知限制和 migration 说明；
- 发布前扫描密钥、个人数据、SQLite/WAL、日志、浏览器资料、构建产物和机器绝对路径；
- 不包含容器配置或要求外部数据服务的安装路径。

---

## 12. 自动化测试与真实验收

### 12.1 测试层级

- **领域测试**：任务匹配、时间计算、三态状态机、退号 30 分钟窗口、去重和规则过期；
- **SQLite 集成测试**：真实临时数据库、migration、约束、Job 领取、租约恢复、Outbox 事务和备份恢复；
- **Worker 集成测试**：真实 Worker Thread，杀线程后验证 Job 恢复和健康状态；
- **Adapter 契约测试**：脱敏真实 Fixture、错误分类、结构漂移和官方域名白名单；
- **Playwright E2E**：本地 Web 创建任务、Fixture 状态变化、通知 Capture Adapter、重启恢复；
- **Live 验收**：低频访问真实官方来源并与同一时刻人工页面对照；
- **真实通知验收**：向真实邮箱发送测试通知和规则提醒。

CI 使用临时 SQLite 文件和真实 Worker Thread，不使用内存仓储代替集成测试。Live 来源和真实 SMTP 密钥不进入 Fork PR 或普通 GitHub Actions。

### 12.2 关键故障路径

1. Worker 在领取 Job 后退出：租约到期后恢复；
2. 事件事务提交后、通知前退出：Outbox 保留；
3. SMTP 发送过程中退出：进入 `delivery_unknown`，不自动重复；
4. 来源超时、429、登录墙、验证码或结构变化：状态为 `unknown`/来源降级，不生成号源事件；
5. 应用停机跨过提醒时刻：超过 5 分钟不补发，显示错过原因；
6. 电脑休眠后恢复：记录空窗并重新建立基线；
7. SQLite 写入失败或磁盘满：停止产生新外部副作用，总健康状态失败；
8. migration 失败：恢复前不启动 Web/Worker；
9. 第二实例启动：获取单实例锁失败，且不发起来源请求；
10. 重复 Fixture 与无语义内容变化：不产生重复事件。

### 12.3 “真实可用”门槛

只有同时满足以下条件，才能宣称号源监控真实可用：

- 至少一个首批目标通过 A 级真实来源；
- 连续运行 7 天，来源计划检查成功率不低于 95%；
- 至少 10 次人工抽查与官方页面归一化状态一致；
- 真实 SMTP 测试通知在用户设备收到；
- 放号前 5 分钟提醒误差不超过 ±30 秒；
- 来源失败、Worker 重启和本机休眠恢复不产生假事件；
- SQLite、日志、备份、Fixture 与测试产物中没有医院会话凭据或敏感身份信息。

Fixture 只能证明数据流和状态机，不证明目标医院当前可稳定监测。

---

## 13. 无法承诺的能力

在缺少官方公开 API、稳定公开页面或本机有效登录态时，不能承诺：

1. 实时或准实时号源；本地进程只做低频轮询；
2. 准确剩余数量；来源只展示“可约/约满”时不能推算库存；
3. 确定发生退号；没有官方事件字段时只能提示“疑似退号回流”；
4. 所有医生、院区、日期和时段完整覆盖；
5. 微信小程序私有数据监控；仅小程序可见时保持 C 级；
6. 本机关闭、休眠、断网期间持续监测；
7. B 级登录态长期有效；登录墙、验证码、设备校验或风控出现时必须暂停；
8. 检测到有号时用户打开官方页面仍有号；
9. 预约成功；应用不处理登录、实名、医保、验证码、确认和付款；
10. 来源永久稳定；页面改版或条款变化会使 Adapter 暂停；
11. 规则永久准确；超过核验期必须标记待重新确认；
12. 外部邮件服务绝不延迟、丢信或重复；SMTP 的不确定投递窗口必须可见；
13. 绕过任何访问限制；不使用代理池、多账号、账号轮换、验证码识别或高频并发。

界面和通知必须展示来源等级、检测时间、最后成功时间、当前健康状态和官方入口，不能只展示容易被理解为实时保证的“有号”。

---

## 14. 演进路径

每个阶段均可独立发布和使用，后续阶段未完成不影响前一阶段。

### 阶段 1：零基础设施本地核心（v0.1）

实现本地 Web、SQLite migration、持久 Job Runner、规则日历、关注任务、规则提醒、SMTP、Fixture Adapter、健康页、备份与 `npm start`。这一阶段即使没有可用 A 级来源，也能作为真实的规则管理和定时提醒工具使用。

预计实现量：5～7 个工程日。

### 阶段 2：首个真实 A 级 Adapter（v0.2）

为一个无需登录的目标官方来源完成访问政策确认、低频读取、结构断言、脱敏 Fixture、契约测试、人工对照和 7 天观察。若没有来源通过，不用私有逆向替代，产品继续保持 C 级能力。

预计实现量：每个候选来源 2～5 个工程日，另需不可压缩的 7 天观察期。

### 阶段 3：稳定开源发布（v1.0.0）

冻结 Adapter 契约 v1、完成跨平台 CI、全新 clone 验收、升级/恢复演练、许可证与安全文档、真实通知闭环和已知限制说明。只有真实来源门槛通过后才声明“状态监控可用”。

预计实现量：3～5 个工程日，不含真实来源观察期。

### 阶段 4：第二真实来源与 B 级本机会话（P1）

在已有 A 级闭环稳定后再增加第二来源。若目标只能依赖本机登录态，Worker 使用应用专属 Playwright 资料目录和可见浏览器窗口；用户人工登录，规范化结果仍只留本机。该阶段不增加远程 Agent、设备配对或云端同步。

### 回滚策略

- 任一 Adapter 可独立停用并降级为 C 级，不删除规则、任务或历史；
- Worker Thread 可停止而 Web 保持只读健康与历史查看；
- Job 可从 SQLite 重建，事件与通知唯一键防止内部重复处理；
- 版本升级前自动备份，migration 失败时不启动新版本；
- 恢复旧版本时使用升级前备份，不执行破坏性降级 SQL；
- 邮件处于 `delivery_unknown` 时不自动重发，回滚也保持该状态。

---

## 15. 最终建议

GitHub `easy-hospital` 应从**稳定开源、仅本地运行的零基础设施模块化单体**开始：

- Node.js 24 LTS + TypeScript；
- Fastify + React/Vite；
- `better-sqlite3` 单文件持久化；
- SQLite Job Table + Worker Thread 取代外部队列；
- A/B/C 分级 SourceAdapter；
- SQLite 事务 Outbox + SMTP；
- `npm ci` 后根目录 `npm start` 启动全部能力；
- GitHub Actions 验证跨平台安装、SQLite、Worker、Playwright 和升级路径。

首个发布门槛是：本地安装可重复、规则提醒真实送达、失败不会误报、重启不会破坏任务、没有敏感会话数据落盘。号源变化和疑似退号属于独立的真实来源门槛；没有官方公开来源或本机有效登录态时，产品必须降级而不是伪造能力。
