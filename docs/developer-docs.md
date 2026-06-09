# Memory Usage Analysis 开发者文档

## 项目架构

```
Memory Usage Analysis/
├── electron/              # Electron主进程
│   ├── main.ts           # 主进程入口
│   └── preload.ts        # 预加载脚本
├── src/                   # React渲染进程
│   ├── components/       # UI组件
│   │   ├── charts/      # 图表组件
│   │   ├── Layout.tsx   # 布局组件
│   │   ├── ProcessList.tsx
│   │   ├── RealtimeMonitor.tsx
│   │   ├── DataRecording.tsx
│   │   ├── DataFilter.tsx
│   │   ├── Notification.tsx
│   │   └── ReportExport.tsx
│   ├── hooks/           # 自定义Hooks
│   │   └── useMemory.ts
│   ├── services/        # 服务层
│   │   ├── memory.ts    # 内存数据服务
│   │   └── storage.ts   # 持久化服务
│   ├── types/           # TypeScript类型定义
│   │   ├── memory.ts
│   │   └── electron.d.ts
│   ├── i18n/            # 国际化
│   │   ├── index.ts
│   │   ├── zh.json
│   │   └── en.json
│   ├── styles/          # 样式文件
│   │   └── global.css
│   ├── App.tsx          # 主应用组件
│   └── main.tsx         # 渲染进程入口
├── docs/                # 文档
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | 41.x | 桌面应用框架 |
| React | 19.x | UI框架 |
| TypeScript | 6.x | 类型安全 |
| Vite | 6.x | 构建工具 |
| Ant Design | 5.x | UI组件库 |
| Recharts | 2.x | 图表库 |
| react-i18next | 15.x | 国际化 |

## 开发环境搭建

### 前置要求
- Node.js >= 18
- npm >= 9
- Windows 10/11

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run dev
```

### 构建
```bash
npm run build
```

## 核心模块说明

### 1. 内存数据服务 (src/services/memory.ts)

负责内存数据的采集和管理。

```typescript
class MemoryService {
  // 获取进程列表
  async getProcessList(): Promise<{pid: number, name: string}[]>
  
  // 获取进程内存信息
  async getProcessMemoryInfo(processId: number): Promise<ProcessMemoryInfo>
  
  // 获取系统内存信息
  async getSystemMemoryInfo(): Promise<SystemMemoryInfo>
  
  // 开始录制
  async startRecording(config: RecordingConfig): Promise<string>
  
  // 停止录制
  async stopRecording(sessionId: string): Promise<void>
  
  // 格式化字节数
  formatBytes(bytes: number): string
}
```

### 2. 持久化服务 (src/services/storage.ts)

负责数据的本地存储。

```typescript
class StorageService {
  // 保存录制数据
  async saveRecordings(recordings: RecordingSession[]): Promise<void>
  
  // 加载录制数据
  async loadRecordings(): Promise<RecordingSession[]>
  
  // 保存设置
  async saveSettings(settings: AppSettings): Promise<void>
  
  // 加载设置
  async loadSettings(): Promise<AppSettings>
  
  // 导出所有数据
  async exportAllData(): Promise<string>
  
  // 导入数据
  async importData(jsonData: string): Promise<{recordings: number, settings: boolean}>
}
```

### 3. 自定义Hooks (src/hooks/useMemory.ts)

提供React组件使用的内存数据管理Hooks。

```typescript
// 进程列表Hook
function useProcessList(): {
  processes: {pid: number, name: string}[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// 进程内存Hook
function useProcessMemory(processId: number | null, interval?: number): {
  memoryInfo: ProcessMemoryInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// 系统内存Hook
function useSystemMemory(interval?: number): {
  systemInfo: SystemMemoryInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// 录制管理Hook
function useRecording(): {
  sessions: RecordingSession[];
  currentSession: RecordingSession | null;
  loading: boolean;
  error: string | null;
  startRecording: (config: RecordingConfig) => Promise<string | null>;
  stopRecording: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  refresh: () => Promise<void>;
}
```

## 类型定义

### ProcessMemoryInfo
```typescript
interface ProcessMemoryInfo {
  processId: number;
  processName: string;
  workingSetSize: number;        // 工作集大小
  privateWorkingSetSize: number; // 私有工作集大小
  commitSize: number;            // 提交大小
  timestamp: number;             // 时间戳
}
```

### SystemMemoryInfo
```typescript
interface SystemMemoryInfo {
  totalPhysicalMemory: number;    // 总物理内存
  availablePhysicalMemory: number;// 可用物理内存
  totalVirtualMemory: number;     // 总虚拟内存
  availableVirtualMemory: number; // 可用虚拟内存
  memoryLoad: number;             // 内存使用率
  timestamp: number;
}
```

### RecordingConfig
```typescript
interface RecordingConfig {
  processId: number;           // 进程ID
  interval: number;            // 采样间隔(ms)
  duration: number;            // 录制时长(ms)
  metrics: MemoryMetricType[]; // 监控指标
}
```

## 扩展指南

### 添加新的内存指标

1. 在 `src/types/memory.ts` 中添加新的指标类型
2. 在 `src/services/memory.ts` 中实现数据采集
3. 在 `src/i18n/zh.json` 和 `src/i18n/en.json` 中添加翻译
4. 更新图表组件以支持新指标

### 添加新的图表类型

1. 在 `src/components/charts/` 创建新组件
2. 使用Recharts库实现图表
3. 在App.tsx中集成新图表组件

### 集成真实的Windows API

当前使用模拟数据，如需集成真实API：

1. 创建Node.js native addon
2. 使用 `ffi-napi` 或 `node-ffi` 调用Windows API
3. 实现 `GetProcessMemoryInfo` 等函数
4. 更新 `memory.ts` 服务使用真实数据

## 构建和打包

### 开发构建
```bash
npm run build
```

### 生产打包
```bash
npm run electron:build
```

### 生成安装包
- NSIS安装程序: `release/Memory-Usage-Analysis-Setup.exe`
- 便携版: `release/Memory-Usage-Analysis-Portable.exe`

## 测试

### 运行单元测试
```bash
npm test
```

### 运行集成测试
```bash
npm run test:integration
```

## 贡献指南

1. Fork项目
2. 创建功能分支: `git checkout -b feature/xxx`
3. 提交更改: `git commit -m 'feat: add xxx'`
4. 推送分支: `git push origin feature/xxx`
5. 创建Pull Request

### 提交规范

使用Conventional Commits规范：
- `feat:` 新功能
- `fix:` Bug修复
- `docs:` 文档更新
- `style:` 代码格式调整
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具相关
