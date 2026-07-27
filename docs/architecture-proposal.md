# 北京挂号雷达架构说明

> 状态：与 `v0.1.1` 稳定候选同步
>
> 产品形态：稳定开源、单用户、仅本地运行
>
> 当前范围：11 家目录；协和 stable public-source；安贞两个 experimental public-source；同仁 rules-only；其余 directory-only

## 1. 决策摘要

北京挂号雷达是一个**本地模块化单体**：一个 Node.js 24 进程承载 Fastify API、React 静态页面、进程内 `LocalWorker`、SQLite Job Runner、来源 Adapter 和通知渠道。`better-sqlite3` 是唯一持久化事实源；内存 timer 只负责唤醒，不保存不可恢复的业务事实。

用户完成一次安装与本地配置后执行：

```bash
npm start
```

应用固定监听 `127.0.0.1`，不提供 Docker、外部数据库、Redis、远程控制面、多用户注册、云同步或项目自有后端。

当前实现没有独立 Worker 进程或 `worker_threads`。`LocalWorker` 与 HTTP 服务在同一 Node.js 进程中运行，共用同一数据库连接和事务边界；网络操作不应占用 SQLite 写事务。

## 2. 稳定能力边界

| 来源 | 等级 | transport | 稳定能力 |
|---|---|---|---|
| 北京协和医院东单院区皮肤科公开排班 | `public-source` / A / `stable` | `fetch` | 低频检查严格 binding 的公开排班，只产生 `schedule_released` |
| 北京安贞医院朝阳院区冠心病中心、心律失常中心 | `public-source` / A / `experimental` | `fetch`，同域两个 binding 串行 | 官方心脏内科医学中心排班，只产生 `schedule_released` |
| 北京同仁医院崇文门院区鼻科 | `rules-only` / C | `rules-only` | 需复核规则和放号前提醒，不运行号源检查 |
| 其余 41 个 target | `directory-only` | 无自动来源 | 只浏览目录与 HTTPS 医院官网，禁止创建/恢复任务 |
| Browser Agent | B | 本机扩展 observation | 实验/P1，默认关闭；11 家目录不扩大其 scope |

`availability_changed_to_available` 和 `cancellation_slot_detected` 的状态机、存储与实验 UI 存在，但没有真实医院稳定声明。架构不能把测试 fixture 或 B 级 observation 写成实时余号/退号承诺。

## 3. 运行结构

```text
用户浏览器
    │ HTTP（仅 loopback）
    ▼
┌──────────────────────────────────────┐
│ 单个 Node.js 进程                    │
│                                      │
│ Fastify API + React 静态页面         │
│          │                           │
│          ├── CRUD / 健康 / 本机安全  │
│          │                           │
│          └── LocalWorker             │
│               ├── Planner            │
│               ├── SQLite Job Runner  │
│               ├── SourceAdapter      │
│               └── Notifier           │
└───────────────┬───────────┬──────────┘
                │           │
                ▼           ├── 医院官方公开来源
       better-sqlite3       ├── macOS Notification Center
       本地 SQLite          ├── Bark
                            └── SMTP
```

### 3.1 启动顺序

生产入口按以下边界启动：

1. 解析并校验 loopback host、北京时间和数据目录；
2. 创建数据目录并在支持 POSIX 权限位的平台收紧权限；
3. 获取数据库实例锁；
4. 打开 SQLite，执行 `integrity_check` 和 migration manifest 校验；
5. 若有 pending migration，创建并验证一致性备份，再在事务中迁移；
6. 构建通知渠道和来源 Adapter；
7. 从 SQLite 恢复任务并启动 `LocalWorker`；
8. 启动 Fastify，输出本机 URL。

关闭时停止 Worker、关闭 Fastify/SQLite，并只释放当前进程实际持有的数据库锁。

### 3.2 数据库实例锁

应用启动与 `restoreDatabaseBackup` 共用 `acquireDatabaseLock(databasePath)`：

- 锁目录为 `<database>.lock`，owner 包含 PID、启动时间和随机 token；目录/owner 使用当前用户权限。
- 创建锁使用原子目录和 `owner.json` 的排他写入。
- owner PID 仍存活时，第二实例或 restore fail closed。
- PID 已退出时，回收方先通过原子 rename claim owner，再比较原始内容、device/inode 和进程状态；确认同一 stale owner 后才能删除并重建锁。
- owner 损坏、身份变化、PID 复活或并发回收无法确认时拒绝操作，不删除可能属于其他进程的锁。
- release 同样先 claim 并验证 PID/token，不能释放别的实例取得的新锁。

这消除了“启动会回收 stale lock、restore 却只看目录存在”的不一致，也防止恢复与运行实例并发修改数据库。

## 4. 模块边界

| 模块 | 职责 | 不负责 |
|---|---|---|
| `src/server/app.ts` | Fastify 路由、输入校验、本机安全、装配 Worker/Runner | 医院页面解析 |
| `src/server/local-worker.ts` | 到期 Job、来源检查、通知、健康与恢复编排 | 持久化 schema |
| `src/storage/scheduling.ts` | 任务计划、release occurrence、scope reconciliation | 发送通知 |
| `src/storage/job-runner.ts` | Job enqueue/claim/complete/fail、租约恢复 | 解释规则或来源语义 |
| `src/storage/notification-outbox.ts` | 批次/投递状态、原子 claim、终态 | 决定来源状态 |
| `src/storage/database.ts` | SQLite、migration、integrity、备份/恢复 | 规则调度 |
| `src/storage/database-lock.ts` | 启动/恢复共享的原子实例锁 | 打开 SQLite |
| `src/adapters/sources/*` | 来源 manifest、读取、解析、错误分类 | 任务与通知 |
| `src/adapters/notifications/*` | 渠道配置、发送和结果规范化 | 重试计划 |
| `src/core/*` | Zod 契约与领域校验 | IO 与进程生命周期 |

关键 seam 是 `SourceAdapter`、`NotificationChannel` 和可控 `now()`。SQLite/Fastify 不建设没有实际替代者的通用插件层。

## 5. SQLite 与 migration

SQLite 使用外键、`CHECK`、唯一索引和短事务。时间持久化为 UTC 毫秒，界面按 `Asia/Shanghai` 展示。关键事实包括：

- `watch_task` 与 `watch_task_event_type`；
- `release_rule`；
- 来源 runtime、监测 baseline、快照与事件；
- `job` 的 run/lease/attempt/dedupe 状态；
- `notification_batch` 与每渠道 `notification_delivery`；
- `schema_migration` 的 version/name/checksum。

### 5.1 migration manifest

- migration 1–15 是历史 schema；
- migration 16 建立历史 migration checksum 基线；
- migration 17 `hospital-domain-policy` 新增 `hospital_domain(hospital_id, domain, kind)`，`kind` 只允许 `official` 或 `evidence`；
- migration 18 `beijing-hospital-directory` 新增医院/院区排序、唯一 `target_id`、`active/support_mode/can_create_watch_task`、41 个新目录 target 与 `source_scope_runtime`。

规则 URL 校验只读取 `hospital_domain`：`officialEntryUrl` 必须命中该医院 `official` kind，`sourceUrl` 必须命中 `evidence` kind。一个医院官方域如同时承担来源证据，需分别登记两个 kind。未登记域 fail closed。

打开已有磁盘库时先执行 `integrity_check` 和 manifest 校验。有 pending migration 时用 `VACUUM INTO` 创建一致性备份，验证后才迁移，迁移完成后再次检查完整性。新库和 `:memory:` 库不创建迁移备份；迁移备份保留最近 5 份。

### 5.2 权限

在支持 POSIX 权限位的平台：

- 数据、备份和 rollback 目录：`0700`；
- SQLite、WAL/SHM、迁移备份、restore 临时文件和 rollback：`0600`；
- 生产 `.env`：启动时尝试收紧为 `0600`。

不支持 POSIX 权限位的平台容错使用平台 ACL，不因 `chmod` 不可用而伪造成功。

### 5.3 restore

`restoreDatabaseBackup` 必须在停机后显式调用：

1. 获取与生产启动相同的数据库实例锁；
2. 验证备份 integrity 和 migration manifest；
3. 把当前主库及现存 WAL/SHM 保存为 `corrupt/` rollback；
4. 复制备份到同目录临时文件，再次验证并 fsync；
5. 同目录原子替换主库，清理旧 WAL/SHM；
6. 释放 restore 自己取得的实例锁。

恢复不自动启动应用，也不执行降级 migration。旧 schema 备份在下一次候选启动时按正常流程再次备份并向前迁移。

## 6. 持久调度

### 6.1 Job 生命周期

`LocalWorker` 周期性调用 `SqliteJobRunner`：

1. 在事务中 claim 到期 `pending` Job，改为 `running` 并写入 lease/attempt；
2. 执行来源或通知副作用；
3. 成功后 `complete`；明确终态失败后结束；可重试失败写入新的 `runAt`；
4. 进程异常后，过期 lease 可恢复，但恢复不能改变领域 deadline。

Job 的 dedupe key 防止 planner 重扫重复物化。同一来源 scope 保持一个 active source-check；多个任务在本地匹配同一 observation。

### 6.2 release reminder payload

规则提醒 Job 持久化：

```text
taskId + taskVersion + ruleId
reminderAt + occurrenceAt + targetDate
officialEntryUrl + needsReconfirmation
```

- `reminderAt` 是不可变的首次计划提醒时刻；`job.runAt` 可被 retry 或 lease recovery 改写，不能代替它。
- `occurrenceAt` 是对应放号时刻，也是发送与重试的最晚 deadline。
- dedupe key 同时包含任务版本、规则、occurrence、目标日期和入口哈希，规则改变目标日期/入口后不会被旧 completed Job 占住。
- 若 reminderAt 已过但 occurrenceAt 未过，可立即入队处理；occurrenceAt 已过则选择下一次 occurrence。

### 6.3 occurrenceAt deadline 与 `RETRY_EXPIRED`

可重试渠道错误使用 1、5、15 分钟阶梯，但下一次 `runAt` clamp 到 `occurrenceAt`：

- 在 `occurrenceAt` 可做最后一次尝试；失败后不再重试。
- 当前时间超过 `occurrenceAt` 且没有任何渠道尝试，批次终态为 `RELEASE_REMINDER_MISSED`。
- 已有失败尝试后跨过 deadline，批次终态为 `RELEASE_REMINDER_RETRY_EXPIRED`；保留最后渠道错误和 attempts。
- 终结当前批次后继续计划下一个未来 occurrence。

因此提前 30 分钟的提醒可以容纳完整 1/5/15 分钟阶梯；提前 5 分钟的提醒只执行 deadline 前可容纳的尝试，不会在放号后继续发送“准备提醒”。

### 6.4 scope reconciliation

规则按医院、院区、科室形成 scope。每次规则 POST、影响计划字段的 PATCH、enable/disable 或 DELETE 后：

1. 合并受影响 scope；
2. 以稳定顺序选择唯一 enabled 规则；
3. 取消不再属于首选规则的 pending reminder Job，并释放 dedupe 位；
4. 将旧批次终结为 `RULE_CHANGED` 或 `RULE_DELETED`，保留 `sent`/`delivery_unknown` 证据；
5. 为 scope 内 enabled 任务立即按当前首选规则计划。

已被 claim 的 running Job 不能由 API 物理删除。Worker 发送前再次校验当前首选规则、occurrence、目标日期与官方入口；不匹配时 0 发送、终结旧批次并补排当前规则。这样停用/删除当前规则后，备用规则无需重启即可接管。

## 7. 来源与 baseline

### 7.1 SourceAdapter 契约

Adapter manifest 声明：

- `adapterKey`、contract/version；
- A/B/C access class 与 `stable/experimental` 稳定性；
- `sourceId`、跨 binding 共用的 `rateLimitKey`；
- transport、允许域、最小间隔和可产生事件；
- 每个精确 `targetId + hospitalId + campusId + departmentId + officialEntryUrl` binding。

`TargetSupportRegistry` 先按 catalog scope 解析 target，再决定是否允许创建任务；`public-source` 调度只接受 manifest binding，`rules-only` 只接受严格规则 payload，`directory-only` 与 inactive target 一律 fail closed。来源页也以 target/binding/sourceId 匹配，不能按 access class 找到第一个 Adapter。

请求只包含公开 scope、日期/条件和 deadline，不含患者身份、Cookie、Token 或验证码。结果通过 Zod 严格解析，错误分类为可解释状态；原始 HTML、请求头、截图、Trace 和浏览器存储不进入 SQLite。

### 7.2 协和策略

- 当前 manifest 最小间隔为 2 小时，同来源并发为 1。
- 正常 `OK` 且结构完整的结果可更新 baseline；异常、登录墙、限流、`PARTIAL` 空结果和解析失败返回 `unknown`/失败状态。
- 第一次成功检查只建立 baseline。
- 目标排班首次出现在后续成功结果时产生 `schedule_released`；通知明确排班不代表可预约。

### 7.3 安贞实验来源

安贞 Adapter 的一个 manifest 绑定朝阳院区冠心病中心与心律失常中心。两个 target 共用 `official-html:anzhen.org.cn` 域级节流，但 baseline 与 `source_scope_runtime` 按 scope 独立；parser 或页面上下文不能覆盖心脏外科、小儿心脏中心、血管外科。WAF、登录墙、结构漂移、越界重定向或不完整周表全部返回诊断状态，不产生 observation。

### 7.4 监测空窗

Worker 在记录本次 attempt **之前**读取上次来源 attempt：

- 间隔约 1× 有效最小间隔：正常比较 baseline；
- 间隔严格大于 2× 有效最小间隔：删除该 source scope 的监测 baseline，保留审计状态，本轮静默重建；
- 协和当前阈值为 `>4h`。

这避免短调度抖动误触发 rebaseline，也避免长时间停机/休眠后把离线差异冒充新排班。

### 7.5 Browser Agent

Browser Agent 默认关闭。配置后使用固定 loopback challenge/observation 端点、nonce + HMAC-SHA256、Bearer 配对 token、时间窗和 replay 防护。扩展只提交白名单 schema 的脱敏 observation，不提交 Cookie、Token 或任意脚本。

B 级 observation 和实时状态事件仍是实验/P1；它们不改变 catalog support，也不会因新增 11 家目录而扩展 manifest 权限、scope 或 parser。

## 8. 通知一致性

### 8.1 批次与投递

每个通知批次为每个已配置渠道创建独立 delivery。多渠道是并发投递，不是主备切换。批次状态由 delivery 聚合，必须保留：

- `sent`：渠道明确接受；
- `delivery_unknown`：发送过程中断，无法确认；不自动重发；
- `failed`：明确失败或领域终态；
- `pending/sending`：尚未结束的内部状态。

### 8.2 原子 claim

发送流程是：

1. 读取待投递记录；
2. `markDeliverySending` 以条件更新原子 claim；
3. 只有 claim 成功的 Worker 才调用渠道；
4. `recordDeliveryResult` 只允许从当前 `sending` 状态回写。

规则 PATCH/DELETE 可在渠道发送并发发生。已 claim 渠道的实际结果可以保留，但未 claim 渠道不会发送；规则终态不能被陈旧 worker 的结果覆盖。

### 8.3 渠道边界

生产运行时按条件装配 macOS 本机通知、Bark 和 SMTP。通知秘密只来自环境变量，不进入前端、SQLite、备份、日志或健康响应。渠道返回成功只证明服务接受，用户仍需在设备/邮箱确认真实送达。

## 9. 本机 HTTP 与安全

- Fastify 固定绑定 `127.0.0.1`；Host 只接受 loopback，忽略/拒绝代理信任语义。
- 带 `Origin` 的普通写请求必须来自 loopback Web Origin，并携带 `x-easy-hospital-client: web`；跨站或缺头返回 403。
- 无 Origin 的本机 CLI 请求保留，但仍经过 Host、schema、catalog、日期和来源政策校验。
- Browser Agent observation 只接受 `chrome-extension://` Origin，并走独立配对协议。
- 5xx 响应统一脱敏；不回显 SQL、schema、文件路径或内部异常。
- Adapter URL 与重定向受 manifest/domain allowlist 限制，阻止 loopback、私网、云元数据和非 HTTPS scheme。
- 不保存医院账号、Cookie、Token、身份证、医保卡、病历或支付信息；默认无遥测。

## 10. 测试与发布架构

自动化分层：

- 领域/契约：日期、状态机、URL、Adapter、通知渠道；
- 磁盘集成：migration、SQLite busy、Job lease、规则 reconciliation、通知 claim、共享锁和 restore；
- Playwright E2E：真实 Chromium + loopback 应用 + 隔离数据目录；
- RC：全新 copy、`npm ci`、build、smoke、v17→v18 备份/迁移/恢复，并保留 v14 真实旧 catalog schema 兼容覆盖；
- live/真实渠道：只由维护者显式低频执行。

普通 CI/E2E 禁止真实医院外联、真实通知和 Browser Agent token。E3 与 7 天 soak 只用于把实时余号/退号升级为稳定声明，不阻塞当前协和 stable 排班、安贞 experimental 排班、同仁 rules-only、目录、安全或 UI 补丁。

## 11. 演进与回滚

项目自 `v0.1.0` 起按稳定版本发布，不以某个未来主版本号作为“稳定”的前置条件。

演进顺序：

1. 保持本地核心、规则提醒、协和公开排班和恢复安全可重复；
2. 在不扩大声明的前提下继续隔离测试实时状态与 Browser Agent；
3. 只有真实来源 E2、自然变化 E3、7 天 soak、真实送达和隐私评审全部通过，才单独决策是否将具体实时能力升稳；
4. 新来源必须能独立停用并降级，不影响规则、任务和历史。

回滚时停止应用，使用与旧版本 schema 匹配的升级前备份，不执行破坏性降级 SQL。恢复后按 2× 间隔 grace 处理 baseline，不补造停机变化；`delivery_unknown`、`sent` 和规则终态保持不可逆证据。
