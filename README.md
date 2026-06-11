# Memory Usage Analysis

Windows 进程内存实时监控 / 突变检测 / 泄漏检测 / 数据录制 / 报告导出的桌面工具。

基于 **Electron + 原生 JS + Canvas**，无 React/Vite/Antd 重型框架依赖，体积小、启动快、低资源占用。

## 特性

- **实时监控** — 2 秒一次轮询 PowerShell 后端，Top-N 进程 + 系统内存
- **突变检测** — 滑动窗口 + 峰值跟踪，识别短时内存突刺
- **泄漏检测** — 最小二乘线性回归，识别长时缓慢增长
- **数据录制** — 持久化 JSONL（~1.4MB/h），支持 CSV 导出
- **历史快照** — 一键导出全进程 CSV/JSON 用于离线分析
- **配置持久化** — 阈值、Top N、间隔全部可调
- **中文 UI** — 进程名/标签/通知全中文

## 快速开始

```bash
npm install
npm start              # 启动桌面应用
npm test               # 运行所有测试 (13 个套件)
npm run test:theme     # 单独跑某个测试
npm run bench:powershell  # PowerShell REPL 性能基准
npm run dist           # 打包成 Windows 安装包 / 便携版
```

需要 Windows 10/11 + PowerShell（系统自带）。

## 项目结构

```
.
├── src/                  # 渲染进程 (vanilla JS + Canvas)
│   ├── index.html
│   ├── renderer.js       # 薄编排器
│   ├── styles.css
│   └── modules/          # 业务模块（state / charts / search / process-table / ...）
├── electron/             # 主进程
│   ├── main.cjs          # 薄编排器
│   ├── preload.cjs
│   └── services/         # 主进程服务（ps-session / recording / config / window / csv）
├── tests/                # 全部测试（13 个套件 + 2 个基准 + 共享框架）
│   ├── unit/             # 单元/集成测试套件
│   ├── bench/            # 性能基准
│   ├── integration/      # 端到端集成测试
│   ├── fixtures/         # 共享 mock 数据
│   ├── scripts/          # 一次性迁移脚本
│   └── run-all.cjs       # 总测试入口
├── ARCHITECTURE.md       # 详细架构文档
├── package.json
└── README.md
```

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 架构亮点

- **PowerShell REPL** — 启动一次 `powershell.exe`，按 REPL 协议通信（`COLLECT\n` → JSON → `READY\n`）。对比每次 tick 重新 spawn 进程，**提速 4.8x**（cold 359ms → warm 75ms）。
- **长会话 PowerShell** — 单进程多请求排队，避免 JSON 响应交错。
- **无前端框架** — 弃用 React/Vite/Antd/Recharts 后内存占用和崩溃率显著下降。
- **模块化渲染进程** — 1326 行单文件拆成 9 个职责清晰的模块。

## 测试

```bash
npm test                          # 13/13 套件
npm run test:spike                # 单个套件
npm run bench:powershell          # 性能基准
```

测试覆盖：
- 突变检测（boundary、基线窗口、热/温/冷分类）
- 泄漏检测（最小二乘回归、空样本、噪声数据）
- 搜索（子串、模糊、PID 匹配、缓存命中）
- 录制（启停、Top-N、JSONL 写入、文件轮转）
- 配置（持久化、迁移、默认值）
- 快照导出（CSV/JSON 格式、字段完整性）
- 上下文菜单（搜索/复制/打开位置/结束）
- 状态栏（采集时延、PS 存活状态、Top N 摘要）
- 主题模块（latencyColor/loadColor boundary）
- 重构后的模块结构（JSDoc 覆盖率、文件位置）

## 配置

应用首次启动时在 `userData/config.json` 创建默认配置。字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `spikeThreshold` | 50 | 突变百分比阈值（基线窗口内） |
| `leakThreshold` | 30 | 泄漏百分比阈值（线性回归斜率） |
| `recordingTopN` | 20 | 录制时每个采样点保留的 Top N 进程数 |
| `recordingInterval` | 2000 | 录制采样间隔（毫秒，最小 1000） |
| `notificationCooldown` | 60 | 同一进程通知冷却（秒） |

## 性能数据

- **PowerShell REPL**: 4.8x 提速（cold start 359ms → warm 75ms）
- **每 tick 渲染**: 0.432ms → 0.207ms（52% 节省）
- **录制文件大小**: Top20@5s ≈ 1.4MB/h
- **测试套件**: 13 套件, 391+ 测试用例, 全部通过

## 许可

MIT
