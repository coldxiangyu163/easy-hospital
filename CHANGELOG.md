# 变更记录

本文件记录用户可见变化。项目计划在稳定发布后遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和语义化版本。

## [Unreleased]

## [0.1.1] - 2026-07-20

### 修复

- 长时间监测空窗后，只有距上次来源尝试超过该来源有效最小间隔的 2 倍才删除监测基线并静默重建；协和当前最小间隔为 2 小时，因此 grace 为 4 小时。恢复不会把离线差异误报为新排班。
- 通知投递使用原子 `sending` claim，只有成功 claim 的渠道可以发送并回写结果；规则变更产生的批次终态不会再被并发发送覆盖。
- 放号前规则提醒以放号时刻 `occurrenceAt` 为重试截止时间：截止前保留 1/5/15 分钟阶梯，截止后不再发送；从未尝试记为 `RELEASE_REMINDER_MISSED`，已有失败尝试记为 `RELEASE_REMINDER_RETRY_EXPIRED`。
- 规则新增、编辑、停用和删除后按医院/院区/科室 scope 立即 reconciliation，唯一首选规则接管未来提醒；旧批次以 `RULE_CHANGED` 或 `RULE_DELETED` 结束，已发送渠道记录保留。
- 应用启动与人工数据库恢复共用同一原子实例锁；可安全回收已退出进程的 stale lock，不能确认所有权时 fail closed。

### 数据与安全

- 新增 migration 17 `hospital-domain-policy`，以 `hospital_domain` 表统一维护 `official` 与 `evidence` 域：预约入口只接受 `official` kind，证据来源只接受 `evidence` kind；同一官方域可分别登记两种 kind，未登记范围拒绝写入。
- 打开现有数据库时继续执行完整性检查、migration checksum 校验和迁移前一致性备份；数据目录、数据库、WAL/SHM、迁移备份与生产 `.env` 在支持 POSIX 权限的平台收紧为当前用户访问。
- 带 `Origin` 的普通写请求必须同时来自 loopback Web Origin 并携带 `x-easy-hospital-client: web`；5xx 响应脱敏，目录引用和来源政策在写入前校验。

### 界面与契约

- 新建或重新启用任务的日期限制统一为北京时间今天至今天加 14 天；客户端日期边界与服务端校验一致。
- 同仁鼻科 C 级任务统一为规则提醒：客户端忽略医生、职称和时段并只提交 `schedule_released`，API 对不符合该规范的创建或编辑返回 `SOURCE_POLICY_VIOLATION`，不会把 C 级文案写成实时排班或号源状态。
- 任务编辑保留已有事件类型与提醒分钟；来源页区分最后成功和最后失败；补齐 skip link、对比度、对话框 inert 与焦点恢复。

### 能力边界

- 稳定承诺不变：协和皮肤科只识别官方公开页面中的 `schedule_released`；同仁崇文门鼻科只提供 C 级规则提醒。
- `availability_changed_to_available`、`cancellation_slot_detected` 和 Browser Agent 仍是实验性能力；本版本不宣称实时余号、退号现场闭环、自动预约或离线持续监测。

## [0.1.0] - 2026-07-19

### 新增

- 建立稳定开源、本地-only 的公开文档基线。
- 补充安装、配置、运行、测试、隐私和官方预约边界说明。
- 补充贡献流程、安全报告渠道和真实适配器合入门槛。
- 补充数据来源分级、访问频率、失败降级和用户可见文案政策。
- 明确 Node.js 24、npm、`better-sqlite3`、单进程和 `npm start` 的运行契约。
- 采用 MIT License，并把项目标记为不发布到 npm Registry 的私有应用包。

### 已确认范围

- 首个真实适配器只承诺识别北京协和医院皮肤科公开页面中的新排班发布。
- 北京同仁医院崇文门院区鼻科首版只提供规则与放号前提醒。
- 排班不等于号源，当前真实适配器不承诺实时有号、可预约数量或退号检测。
- 应用只在本机运行，不使用 Docker、外部数据库、外部队列、遥测或项目自有后端。

### 已知限制

- 真实来源可用性受医院页面、访问限制和规则变化影响；失败时只返回 `unknown`/来源异常。
- 协和 A 级来源不检测排班移除、实时有号或退号。
- Browser Agent 为默认关闭、尚待真实会话长期验证的实验能力。
- 同仁鼻科规则标记为需要人工复核，提醒不代表医院当前承诺。

### 发布门槛

- 全新 checkout 中的 `npm ci`、lint、类型检查、测试、构建和 Playwright E2E 全部通过。
- `better-sqlite3` 真实磁盘集成、进程重启、备份恢复和单实例检查通过。
- 协和公开排班适配器完成官方页面人工比对和低频观察。
- 至少一个当前平台真实通知渠道完成接收端确认；Bark/SMTP 仍需使用者以自己的凭据分别自检。
- 仓库、SQLite、日志、Fixture 和 CI artifact 隐私扫描零命中。
- `package.json`、`package-lock.json`、README 与 `LICENSE` 的 MIT 许可证口径一致，且 npm 包保持 `private: true`。
