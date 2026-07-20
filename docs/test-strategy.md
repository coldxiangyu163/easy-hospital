# 北京挂号雷达 · 测试与验收策略

> 决策基线：稳定开源、仅本机运行、Node.js 24、单进程、`better-sqlite3` 磁盘 SQLite。测试必须区分“当前稳定承诺”与“实验性实时号源声明”。

## 1. 测试结论

### 1.1 当前稳定承诺

发布门禁必须证明：

1. 北京协和医院东单院区皮肤科公开排班可被规范化，baseline 后的新排班只产生 `schedule_released`；排班不被写成实时有号。
2. 北京同仁医院崇文门院区鼻科只创建 C 级规则提醒；医生、职称、时段和实时状态条件不参与判断。
3. 任务日期同时限制为北京时间 today..+14d（含两端）且连续最多 14 个自然日；客户端提示与 API 校验一致。
4. 规则提醒可持久恢复、按 scope reconciliation，并且失败重试不越过 `occurrenceAt`。
5. 通知渠道只有成功 claim 到 `sending` 后才能发送/回写；规则变更终态不会被并发投递覆盖。
6. 来源异常、停机和休眠恢复不会制造假事件；超过来源有效最小间隔 2 倍才静默重建 baseline（协和当前为 4 小时 grace）。
7. migration、实例锁、备份与恢复、Origin/Host、官方域、权限和隐私边界 fail closed。
8. 全新 checkout 可按锁文件安装、构建、测试和启动，不依赖 Docker、外部数据库、队列或项目后端。

### 1.2 实验能力及其升级门槛

以下能力不属于当前稳定声明：

- `availability_changed_to_available`；
- `cancellation_slot_detected`；
- Browser Agent 提交的 B 级实时 observation；
- “实时余号/退号现场闭环”或“登录态长期可用”。

这些路径仍需单元、契约和隔离集成测试，避免实验功能破坏稳定核心；但自然发生变化的 E3 和 7 天 soak **不是**只修复协和排班、同仁规则提醒、存储、安全、UI 或文档的补丁发布阻塞项。

只有准备把某个医院的实时余号/退号从“实验”提升为稳定能力时，才必须同时满足：对应真实来源 E2、自然变化 E3、真实渠道送达、至少 7 天 soak、人工同时刻比对和独立的产品/隐私评审。没有 E3 时只能保持实验标签，不得用 fixture 回放代替现场声明。

## 2. 证据等级

| 等级 | 证据 | 能证明什么 | 当前补丁门禁 |
|---|---|---|---|
| E0 | 合成数据、stub、capture notifier | 局部逻辑与错误分支 | 必需但不能单独证明来源可用 |
| E1 | 脱敏官方格式 fixture，经生产 Adapter、SQLite、Runner 和 UI 回放 | 真实格式解析与可重复本地链路 | 稳定边界必需 |
| E2 | 维护者显式低频访问 live 官方来源并同时人工比对 | 当前来源可达、公开排班语义正确 | Adapter/来源行为变化时必需；普通 CI 禁止运行 |
| E3 | 自然发生的状态变化，经真实调度和真实通知账号送达 | 对应现场变化闭环 | 只阻塞将实时余号/退号升级为稳定声明 |

协和 `schedule_released` 的稳定声明不等于实时余号 E3；同仁 C 级规则提醒也不依赖实时号源 E3。

## 3. 执行层级

| 层级 | 范围 | 时机 |
|---|---|---|
| 静态与单元 | schema、匹配、日期、状态机、去重、脱敏、URL policy | 每次提交 |
| 契约 | SourceAdapter、通知渠道、Browser Agent、migration manifest | 每次提交 |
| 磁盘集成 | HTTP、SQLite、Runner、规则重排、通知 claim、锁与恢复 | 每次 PR/RC |
| Playwright E2E | 真实 Chromium + 本地应用 + 隔离数据目录 | 每次 PR/RC |
| 全新 clone/smoke | 锁文件安装、构建、迁移、启动、退出 | 每个 RC |
| live/真实渠道 | 官方来源、真实设备、低频观察 | 维护者显式执行；不进入普通 fork/CI |
| E3/soak | 自然实时变化与长期运行 | 仅实时能力升稳时 |

普通 CI 和 E2E 必须设置 `EASY_HOSPITAL_DISABLE_LIVE_SOURCES=1`，移除真实通知配置和 Browser Agent token，并阻断服务器端与浏览器端非 loopback 请求。

## 4. 稳定领域门禁

### 4.1 协和公开排班

- 使用脱敏 fixture 覆盖正常排班、多医生/日期/午别、合法空内容、字段缺失、维护页、403、418、429、5xx、超时和结构漂移。
- 只跟随允许官方域内的一次重定向；越界、循环或第二次重定向 fail closed。
- `PARTIAL` 空结果、解析失败和 `unknown` 不建立可信空 baseline，不产生事件。
- 首次成功检查只建立 baseline；后续首次出现匹配排班产生一个 `schedule_released`。
- 重复快照、无语义变化和不匹配任务条件不重复产生事件。
- 通知正文写“新排班已发布/排班不代表可预约状态”，不得写实时有号、库存或退号。

### 4.2 同仁 C 级规则提醒

- UI 隐藏医生/职称/时段及实验事件条件，并提交规范化 payload。
- API 对不符合 `any_expert`、空医生/职称、`ANY`、只含 `schedule_released`、非空提醒分钟的 payload 返回 `SOURCE_POLICY_VIOLATION`；不得静默接受或转换。
- 通知使用“预计放号/规则提醒”，不声称检测到新排班或可用号源。
- 规则官方入口、证据 URL、核验日期和需复核状态来自当前规则。

### 4.3 日期与北京时间

- 创建、修改日期或重新启用任务时，范围必须同时满足北京时间 today..+14d（含两端），以及开始到结束连续最多 14 个自然日。
- 分别覆盖窗口边界与跨度边界：today→today+13 合法，today→today+14 因连续 15 个自然日而拒绝，today+1→today+14 合法；同时覆盖北京时间/UTC 跨日、月末、年末、闰日和机器 `TZ` 不同的场景。
- UI 日期测试冻结系统时间，预期使用独立的固定日期字面量，不从生产 helper 反算。

### 4.4 空窗与 baseline

- 正常约 1× 间隔轮询不重建 baseline。
- 上次 attempt 到当前检查超过 2× 有效最小间隔时，删除该 scope 的监测 baseline，本轮静默重建；审计状态保留。
- 协和 manifest 当前最小间隔 2 小时，边界测试覆盖 `4h` 不重建与 `>4h` 重建。
- 空窗恢复不产生 `schedule_released`、实时状态或退号事件；健康读模型显示最近重建时间。

## 5. 规则调度与通知门禁

### 5.1 occurrence 与重试 deadline

- Job payload 持久化不可变 `reminderAt`、`occurrenceAt`、目标日期、规则和任务版本。
- 首次提醒可在 reminderAt 后、occurrenceAt 前恢复并立即处理；`runAt` 因 retry/lease 改写不能改变原始提醒时间。
- 1/5/15 分钟重试阶梯的下一次 `runAt` clamp 到 `occurrenceAt`。
- 在 `occurrenceAt` 可以做最后一次尝试；失败后不再重试。
- 超过 `occurrenceAt` 且从未尝试，批次终态为 `RELEASE_REMINDER_MISSED`。
- 超过 `occurrenceAt` 且已有失败尝试，批次终态为 `RELEASE_REMINDER_RETRY_EXPIRED`，保留最后渠道错误和 attempts。
- 结束旧 occurrence 后仍安排下一次未来 occurrence。

### 5.2 通知 claim 竞态

- `markDeliverySending` 只有从允许状态成功转移时返回 claim 成功；未 claim 的 worker 不调用渠道。
- `recordDeliveryResult` 只接受当前 `sending` 投递，不能覆盖规则变更、删除或其他终态。
- 在渠道 A 正在发送时 PATCH/DELETE 规则：A 的已发生结果可落地，尚未 claim 的渠道 B 不发送，批次保持 `RULE_CHANGED`/`RULE_DELETED`。
- `sent` 与 `delivery_unknown` 是不可逆证据；终结旧批次时保留。

### 5.3 scope reconciliation

- 规则新增、PATCH 时间/入口/提前天数/启停、DELETE 都触发医院+院区+科室 scope reconciliation。
- 同 scope 按确定顺序只选择一个 enabled 规则；停用/删除当前规则后备用规则即时接管，不依赖重启。
- 旧 pending Job 取消并释放 dedupe 位；漏网 running Job 在发送前再次校验 current selected rule，0 发送后补排当前规则。
- 旧批次进入 `RULE_CHANGED` 或 `RULE_DELETED`，不会永久 pending。

## 6. SQLite migration、锁与恢复

### 6.1 每次 PR 的数据库门禁

- 空数据库执行 migration 1–17；重复打开幂等。
- 已应用 migration 的 version/name/checksum 连续且与 manifest 一致；历史 SQL 或记录被改写时 fail closed。
- 真实磁盘 SQLite 启用外键、WAL、同步与 busy timeout；测试结束关闭句柄并清理 WAL/SHM。
- 数据目录/备份/rollback 目录在 POSIX 为 `0700`，数据库、WAL/SHM、备份/rollback 文件为 `0600`。
- 第二实例和人工 restore 共用同一数据库实例锁；活进程锁拒绝、可确认死 PID stale lock 安全回收、损坏/竞态锁 fail closed。

### 6.2 v16 → v17 RC 演练

涉及 migration 17 的稳定候选必须在**临时副本**完成：

1. 准备通过 integrity/manifest 校验的 schema v16 脱敏数据库，包含规则、任务、Job、批次与通知状态；
2. 启动候选，确认 migration 前自动创建 `migration-v16-to-v17` 一致性备份并通过只读验证；
3. migration 17 只新增 `hospital_domain` 及正确的 `official`/`evidence` 种子，原业务数据和状态不丢失；
4. 重启候选，确认 checksum 幂等、规则 URL 校验和未来调度正常；
5. 完全停机后调用 `restoreDatabaseBackup`，确认它取得共享实例锁、保存 rollback、原子恢复 v16 备份并清理 WAL/SHM；
6. 再次启动候选，确认会重新备份并迁移到 v17；
7. 全程扫描备份、rollback、日志和输出，不含真实凭据或机器专属公开信息。

不得在用户唯一数据库或运行中的真实实例上做演练。

### 6.3 retention 与每日幂等清理

- 用可控时钟和真实磁盘 SQLite 建立未到期/恰到期/已过期样本：可用性快照保留 30 天，检测事件、通知批次和通知投递保留 90 天。
- 每日 cleanup Job 必须由生产 Runner 领取执行；不得在测试中直接删除表记录来代替生产路径。
- 同一日期重复 planner、重复领取恢复或重复执行 cleanup，最终数据库状态相同且 Job/dedupe 不膨胀。
- 清理后过期数据为零，未到期数据完整；外键、事件—批次—投递关联与仍在保留期内的去重证据不被破坏。
- 测试明确区分业务 retention 与迁移备份/rollback 保留，不允许 30/90 天清理误删备份文件。

## 7. 本机 HTTP 与安全门禁

- 真实 socket 测试固定绑定 `127.0.0.1`，覆盖 Host、absolute-form、`X-Forwarded-*`、DNS rebinding 和 Origin。
- 带 Origin 的普通写请求必须是 loopback Web Origin 且携带 `x-easy-hospital-client: web`；缺头或跨站请求返回 403。
- 无 Origin 的本机 CLI 写请求仍需通过 Host、schema、catalog、日期和来源政策校验。
- Browser Agent 只接受 `chrome-extension://` Origin，并使用独立 nonce/HMAC/Bearer 配对；未配置时 fail closed。
- 5xx 对外只返回脱敏错误；SQLite、路径、schema 和内部异常不得回显。
- migration 17 的 `hospital_domain` 是 URL policy 事实源：entry 必须命中 `official` kind，source 必须命中 `evidence` kind。
- Adapter 出网与重定向只允许 manifest 域；阻止 loopback、私网、链路本地、云元数据和非 HTTPS scheme。

### 7.1 隐私金丝雀与完整历史扫描

- 将明显虚构、可精确检索的密钥、Cookie、Token、手机号、身份证号、用户绝对路径、PID 和 pane 标识注入成功/失败链路。
- 全链路结束后扫描 SQLite 主库、WAL、SHM、迁移备份、rollback、应用/Runner/Adapter/通知日志、fixture、Playwright/CI artifact；禁止字段明文必须零命中。
- 发布前扫描**完整 Git 历史中的所有对象与路径**，不能只扫描 HEAD 或当前工作树。真实密钥、医院会话、个人数据、SQLite/WAL/SHM、日志、构建/测试产物、机器专属绝对路径、PID、Herdr pane 和临时交接资源必须零命中。
- 历史扫描任一命中即阻塞发布；删除工作树文件不算修复，必须从 Git 历史移除并对重写后的完整历史重新扫描。

## 8. Playwright、CI 与全新安装

### 8.1 可重复 E2E

E2E 必须用真实 Chromium 和真实本地应用，但只使用隔离数据与 loopback：

1. 查看协和公开排班能力边界和同仁规则；
2. 创建、编辑、启停任务，刷新后证明数据来自 SQLite；
3. 触发脱敏 fixture 的 `schedule_released`，确认通知文案不声称有号；
4. 创建同仁 C 级规则提醒，确认实时条件不可选；
5. 重放、重启和删除后不产生重复/陈旧通知；
6. 来源失败显示 `unknown`、最后成功和最近失败；
7. 官方入口属于允许域，打开后停止，不进行登录或预约操作。

### 8.2 GitHub CI

Required checks 至少包括：

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run check:release
npm run smoke:start
npm run test:e2e
npm audit --omit=dev --registry=https://registry.npmjs.org
```

- `npm ci` 后 lockfile 和工作树不得变化。
- Fork/PR 不获得 live 来源、Browser Agent 或真实通知秘密。
- E2E 与 smoke 禁止真实来源，并拦截非 loopback 出网。
- 失败 artifacts 上传前必须脱敏；不上传 SQLite/WAL/SHM、备份、浏览器 profile 或真实消息正文。
- RC 发布门禁必须另跑完整 Git 历史扫描与隐私金丝雀扫描；两者任一非零命中即失败。

### 8.3 RC 全新 copy

- 使用候选 commit 的临时 copy，不复用工作区 `node_modules`、构建产物、数据目录、环境变量或后台进程。
- `npm ci --ignore-scripts` 用于验证锁文件本身可解析且不会改工作树；正式构建/运行依赖原生模块时，再按公开安装流程执行正常 `npm ci`。
- 检查 lockfile 的根版本与 `package.json` 一致；每个非空 `resolved` 都必须是合法 URL 且 hostname 严格等于 `registry.npmjs.org`。
- 执行 build、release metadata、production smoke 和 v16→v17 演练；清理临时数据和密钥。

## 9. 实验实时号源门禁

实验路径的自动化至少覆盖：

- `unavailable → available` 才能产生 `availability_changed_to_available`；`unknown → available`、首个 available 和重复 available 不产生。
- 最近明确 `unavailable → available` 才可产生 `cancellation_slot_detected`，统一写“疑似退号回流”。
- 同次变化命中两个实验事件时聚合，不重复发送。
- Browser Agent 时钟、nonce、proof、Bearer、replay、允许来源与内容 schema fail closed；Cookie/Token 永不离开浏览器会话。

要扩大稳定声明，还必须有独立验收包：

1. 明确医院、科室、来源等级、Adapter/Agent 版本和最小间隔；
2. 7 天本机 soak，来源计划检查成功率达到既定门槛；
3. 至少 10 次同时刻人工比对一致；
4. 捕获自然变化 E3，并经真实通知账号送达；
5. 来源失败、重启、休眠、登录失效不产生假事件；
6. 隐私和网络审计通过。

缺任一项就继续标为实验，不阻塞当前稳定排班/规则提醒补丁。

## 10. 发布验收矩阵

| ID | 当前优先级 | 验收项 | 放行标准 |
|---|---|---|---|
| ST-01 | 稳定阻塞 | 版本与锁文件 | package/lock 同步、CHANGELOG 有版本、官方 registry resolved、`npm ci` 不改树 |
| ST-02 | 稳定阻塞 | migration 1–17 | 空库、checksum、v16→v17 备份/迁移/重启/恢复通过 |
| ST-03 | 稳定阻塞 | 协和新排班 | baseline、`schedule_released`、空窗恢复和诚实文案通过 |
| ST-04 | 稳定阻塞 | 同仁规则提醒 | C 级规范化/API 拒绝、occurrence deadline、当前规则接管通过 |
| ST-05 | 稳定阻塞 | 通知一致性 | delivery claim、批次终态、重试截止和重启恢复通过 |
| ST-06 | 稳定阻塞 | 数据库安全 | 共享实例锁、integrity、权限、备份/rollback 通过 |
| ST-07 | 稳定阻塞 | HTTP/出网 | Host/Origin/client header、URL 域、5xx 脱敏和 loopback 隔离通过 |
| ST-08 | 稳定阻塞 | UI/E2E | 任务、规则、来源健康、无障碍关键流程与真实 Chromium 通过 |
| ST-09 | 稳定阻塞 | 构建与 smoke | lint、typecheck、test、build、release check、smoke、E2E 通过 |
| ST-10 | 稳定阻塞 | retention | 快照 30 天、事件/通知 90 天、每日 cleanup 幂等且不破坏未到期引用 |
| ST-11 | 稳定阻塞 | 隐私与完整历史 | Git 全历史及 SQLite/WAL/SHM/备份/日志/fixture/artifact 金丝雀扫描零命中 |
| EXP-01 | 实验不阻塞 | available/cancellation 自动化 | 状态机与聚合测试通过，仍标实验 |
| EXP-02 | 实验不阻塞 | Browser Agent 自动化 | 配对、重放、脱敏、失效测试通过，仍标实验 |
| EXP-03 | 升稳才阻塞 | E3 + 7 天 soak | 仅用于扩大实时号源/退号稳定声明 |

## 11. 禁止事项与验收包

- 不以重跑掩盖 flaky；固定系统时间或隔离共享资源后定位根因。
- 不把 mock/capture、fixture 或 CI 绿色写成 live/E3。
- 不在普通测试中调用真实医院、真实 Bark/SMTP/macOS 通知或真实 Browser Agent 会话。
- 不把删除数据库重新开始当作恢复验证。
- 不把 E3/7 天 soak 错写为当前排班/规则提醒补丁的发布阻塞项。

每个候选保留脱敏证据：commit、版本、lockfile hash、Node/npm/OS、自动化结果、migration/restore/retention 记录、完整 Git 历史扫描、隐私金丝雀扫描、E2E/smoke 和已知限制。live、真实通知和 E3 证据单独归档，且不得进入公开仓库或日志。
