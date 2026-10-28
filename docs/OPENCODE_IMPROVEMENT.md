# OpenCode Evolution 改良候选（2026-10-07）

最新版本与验证见 [v6 可靠性增量交接](RELIABILITY_V6.md)。下文是 v3/v4/v5 历史设计，
旧提交授权、每轮自测限额及超时默认值不代表当前状态。当前不自动提交比赛。
本工作区 node_modules 是指向 main 的共享软链接，**不要在此执行 npm ci/install**；
下方安装命令仅用于独立解包目录或独立克隆。v6 候选已在干净解包目录安装并通过六组本地验收。

v5 最新增量见 [规划降级与失败留档](OPENCODE_PLANNING_V5.md)。v4 Sheet 因独立自测计划被拒而提前退出；v5 不再把这种失败等同于禁止功能开发。用户已授权本轮改良完成后提交。

v4 最新增量见 [受控自测与可见进度](OPENCODE_DEVTOOLS_V4.md)：父控制器管理开发服务、有限检查、回合退出清理；正常工具进度对平台可见。v3 曾经用户授权正式提交，现已按后续指示取消两任务；本文的本地零模型请求仅指验证阶段。

这是 `improve/opencode-evolution` 特性分支，不是已经验证提分的 main 发布版。
基于 main `289b500cf00949f8492762439d53d5fa90b058dc`；不引入 DSH/Pi，不覆盖平台基线，不自动提交或调用真实模型。

## 改动

- 初赛执行函数保留；决赛入口分派到独立 `evolution/` 控制器。
- 固定 OpenCode 1.18.34，并使用实际 CLI 验证过的 `--auto --format json --session <ID>`。
- 同模块显式续接会话；项目地图首次传入，跨模块仅传最近四段有限交接摘要。没有宣称能够跨控制器进程重启恢复会话。
- 显式 CLI 会话标题，避免引擎为会话命名另发辅助模型请求；实际收益由协议夹具的请求计数核验。
- 检查规划为无工具转换：只接收公开需求和最多 10 个源码文件、2 万字符摘录，不再开启另一轮全仓调查。总规划预算最多 120 秒、最多两次尝试；v5 无有效计划时继续实现，但明确保留独立行为 unchecked，绝不以启动成功冒充行为通过。
- 控制器验证引用、冻结内存副本、执行实际检查，不允许模型把预期改成实际值来消除失败。最终回归包含所有冻结用例，不只重跑曾经通过的用例。
- 单浏览器串行执行；每例独立项目/数据库副本、独立上下文、空闲 localhost 端口，清理自己的服务和临时副本。检查支持可访问角色/标签、输入点击/键盘、刷新、有限 API 断言。
- 最多两轮包内产品修复；每轮抽查最近四个已成功用例，尾部重新执行所有已成功用例。有预算上限与交付预留时间，不是无限循环。
- 事务探针只在内存 SQLite 上加载实际项目的通用助手，检查并发提交和回滚，不写交付数据库、不复制业务实现。
- 分层分类 JSON 日志：运行→需求→阶段→会话→请求/工具，带 INFO/WARN/ERROR/DEBUG。`progress.jsonl` 和 stdout 仅输出进度与告警；`events.jsonl` 保留详细事件。记录阶段耗时、最后工具及目标路径、进程退出信号，长调用每 30 秒心跳。主/子事件按 session/part 去重；辅助请求也经过计量代理。
- 根据 2026-10-07 平台 `arcbench models --json` 公布的价目表估算人民币费用，分别按需求、阶段和会话累计；平台结算 `billedCny` 独立且不能由本地推测。用量缺失、缓存字段缺失、模型未定价、价目超过七天均标不完整或区间。输入已含缓存命中，输出已含推理，不能重复相加。
- 可配置估算费用和请求数限额，在下一次上游请求前拒绝继续花费。估算限额不是精确账单硬上限：正在执行、缺失用量的请求仍可能收费。
- 日志对配置密钥、常见访问密钥和认证字段脱敏，原始日志每通道上限 20 MB。
- OpenCode Task 暂时禁用：本候选保持串行，不宣称已验证真实子代理收益。观察器已能记录 parentSession，聚合有本地夹具覆盖。

## 本地证据

- 正式基线 ZIP SHA256：`54f05d745aae6ed00fd123697fa9f809b7f0ae88847777e2605b085257a05471`。
- 两个任务 `backend/src/database/db_runtime.js` 均为 SHA256 `9e2d9eb5ca3029aea67cb977173e2f1180a8b78c26a713c11adb1f389243dfcd`。
- 两个助手均实际复现 `SQLITE_ERROR: cannot start a transaction within a transaction`，两个独立写入只有一个提交。它是已确认失分风险，不是全部失败的归因。
- 单元/浏览器测试覆盖事件分片、主子聚合、缓存计价、缺失用量、脱敏、退出信号与子进程清理、计划校验、基线保护、规划超时重试、费用限额以及真实浏览器的成功/失败与数据隔离。以候选包验证报告的实际测试数为准。
- 假网关 + 实际 OpenCode 验证了插件加载、显式会话续接、工具调用后 reasoning_content 回传、请求字段和辅助调用计量。
- 完整控制器夹具：故意写错产品提示 -> 冻结浏览器断言失败 -> 同会话修复一次 -> 保存/刷新通过 -> 最终回归通过。没有真实模型费用。
- 真实 CLI 入口夹具：GitHub 保留原始 ROOT 标题、Sheet Evolution 标题，都挂到中性 `requirements/` 目录；均进入新控制器。v5 验证无效计划后继续两包实现并如实报告 partial、API 错误反馈后恢复，以及旧成功用例不抵消当前未验证。夹具不是正式业务全量验收。
- 正式基线小样本：Sheet 入口/工作簿/单元格/刷新；GitHub 登录入口、公开预置账户登录/刷新、设置导航通过。原始数据库未变化。复用了本地依赖，不是干净容器或决赛新增功能验收。
- 基线诊断 v2 曾误写不存在的 “Public profile” 标题；已更正为公开要求/应用的 “Settings” 并重跑 v3。该次定位错误不计入产品失分归因。

## 使用与限制

```sh
npm ci
npm run typecheck
# 首次本地测试需安装对应浏览器；容器内控制器会尝试有时限的安装。
npx playwright install chromium --only-shell
npm test
npm run test:protocol
npm run test:controller
npm run test:entrypoint
```

测试脚本使用假网关；不上传任何内容。Ubuntu 26.04 本地兼容性验证使用
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`，不能据此宣称新系统获得官方支持。
正式容器仍需验证系统库、浏览器下载和模型网关兼容；浏览器不可用会明确记录基础设施失败，不标绿。

必需平台环境：`MODEL`、`OPENAI_BASE_URL`、`OPENAI_API_KEY`。
可选：`TORINE_EVOLUTION_TOTAL_MS`（默认 7 小时）、`TORINE_FINAL_RESERVE_MS`（默认 30 分钟）、
`TORINE_EVOLUTION_NODE_TIMEOUT_MS`（单次实现最多 20 分钟）、`TORINE_THINKING=enabled|disabled`、
`TORINE_REASONING_EFFORT=low|high|max`、`TORINE_MAX_ESTIMATED_CNY`（可选，每任务）、
`TORINE_MAX_MODEL_REQUESTS`（默认 600）。DeepSeek 实现/修复默认发送 thinking enabled + effort high，
规划发送 thinking disabled；其他模型默认继承平台参数。假网关证明出站字段与 reasoning_content 回传，
不能证明平台实际采用了该语义强度；首次真实网关仍需小额验证。参数拒绝不会静默切换为其他配置。

运行记录位于输出目录 `.arc/torine/<时间>/`：人读 `progress.log`、结构化 `progress.jsonl`、`events.jsonl`、`summary.json`、`manifest.json`、`plans.json`、`planning/*.json`、`validation.json`。
`validation.json` 的 localStatus 是 blocked / partial / subset_checked，均不代表平台全量通过。
一般产品失败在有限修复后如实报告并保留交付物，供平台最终评测；控制器/基础设施失效会明确停止并返回非零状态。
stdout 同步简明进度；正在进行或缺失用量的请求费用无法凭空获知。
少量本地检查通过不等于整个需求或隐藏评测通过；不为整条需求虚报 `test:passed/CONVERGED`。
冻结计划和权限是控制措施，不是针对恶意模型的操作系统沙箱。

## 下一道门

候选包集中放在 `/tmp/torine-final-uploads/` 的独立版本目录，旧包保留。
通过干净解包安装和假网关检查后，仍需确认小额真实模型预算，再对正式基线做两任务对照。
未经确认，不合并 main，不上传正式提交，不取消/删除/重排平台运行。
