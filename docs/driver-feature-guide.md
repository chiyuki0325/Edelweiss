# Driver Feature 开发指南

## 概述

Driver Feature 是 Turn 生命周期的插件单元。每个 Feature 是一个实现了部分 `DriverFeature` hook 的对象，通过闭包工厂创建。所有 Feature 在 `features/main.ts` 中按固定顺序注册，顺序即依赖。

## 文件结构

```
src/driver/features/
├── main.ts          # 注册顺序（编排点）
├── types.ts         # MainTurnFeatureDeps 接口
├── context.ts       # 示例：Effect 模式
├── interruption.ts  # 示例：Decision 模式
├── send-message.ts  # 示例：Transform 模式
└── your-feature.ts  # 新增
```

## 创建 Feature

### 工厂签名

```ts
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createMyFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'my-feature',
  // 实现需要的 hook...
});
```

规则：
- 工厂是纯函数，接收 `deps`，返回对象字面量
- `name` 必填，用于调试日志
- 只实现你需要的 hook，其余留 `undefined`（自动跳过）
- 不持有跨 turn 状态 — 每次 turn 都会重新调用 `createMainTurnFeatures`

### 注册

在 `main.ts` 的数组中加入你的 feature：

```ts
import { createMyFeature } from './my-feature';

export const createMainTurnFeatures = (deps: MainTurnFeatureDeps): DriverFeature[] => [
  createContextFeature(deps),
  createInterruptionFeature(deps),
  // ...
  createMyFeature(deps),       // ← 放在依赖它的 feature 之后
  // ...
  createCleanupFeature(deps),  // cleanup 永远最后
];
```

**顺序决定一切**：你的 hook 在同一阶段中按数组位置执行。如果你的 `prepareTools` 依赖 `turn.capabilities`，就必须排在 `capability` 之后。

## Hook 分类

### 三种模式

| 模式 | 返回值 | 语义 | Hook |
|------|--------|------|------|
| Effect | `void` | 副作用：写 `turn.*`、调 I/O | 绝大多数 hook |
| Transform | `ConversationEntry[]` | 管道：前一个输出 = 后一个输入 | `transformStepEntries` |
| Decision | `boolean \| undefined` | 投票：表态或弃权 | `shouldContinue` |

### 执行方式

**Effect** — 顺序遍历，逐个调用：

```ts
for (const feature of features) {
  ctx.signal.throwIfAborted();
  await feature[hook]?.(ctx);
}
```

**Transform** — 链式传递：

```ts
let next = value;
for (const feature of features)
  next = await feature[hook]?.(ctx, next) ?? next;
return next;
```

**Decision** — 后者覆盖前者：

```ts
let decision = initial;
for (const feature of features) {
  const opinion = await feature[hook]?.(ctx, value);
  if (opinion !== undefined)
    decision = opinion;
}
return decision;
```

## Effect Hook 参考

| Hook | 执行时机 | 典型用途 |
|------|----------|----------|
| `prepareTurn` | 准备阶段最先 | 早期校验、跳过判断 |
| `prepareContext` | 准备阶段第 2 步 | 加载 TR、compose entries |
| `prepareCapabilities` | 准备阶段第 3 步 | 设置 `turn.capabilities` |
| `prepareTools` | 准备阶段第 4 步 | 组装 `turn.tools` |
| `preparePrompt` | 准备阶段最后 | 渲染 system prompt |
| `beforeStep` | 每步循环开始 | 步骤级初始化 |
| `beforeModelCall` | LM 调用前 | 注入/修改上下文 |
| `afterModelCall` | LM 返回后 | 记录统计、检查输出 |
| `afterToolResults` | 工具执行完后 | 响应副作用 |
| `persistStep` | 每步结束 | 写 DB |
| `finishTurn` | Turn 成功结束 | 最终副作用 |
| `failTurn` | Turn 异常 | 错误标记 |
| `cleanupTurn` | 无论成功失败 | 重置信号、释放资源 |

准备阶段的 5 个 hook 按固定顺序执行，每个 hook 是一次全链遍历（所有 feature 的 `prepareTurn` 跑完 → 所有 feature 的 `prepareContext` 跑完 → ...），不是一个 feature 跑完全部 prepare 再到下一个。

`afterModelCall` 和 `afterToolResults` 带额外参数（`ModelStepOutput` / `StepOutput`），不使用通用 helper 而是直接 for 循环。语义仍是 Effect。

## Transform Hook

唯一的 Transform hook：**`transformStepEntries`**

用于持久化前修改本步的 entries。前一个 feature 的输出是后一个的输入。

```ts
export const createSendMessageFeature = (): DriverFeature => ({
  name: 'send-message',
  transformStepEntries: (ctx, entries) => {
    const { pruned, pendingPrune } = pruneLengthLimitFailures(entries, ctx.turn.pendingPrune);
    ctx.turn.pendingPrune = pendingPrune;
    return pruned;
  },
});
```

规则：
- 必须返回 `ConversationEntry[]`（修改过或原样返回）
- 不要有重副作用 — 这是「变换数据」不是「做事情」
- 返回 `undefined` 等同于不修改（但显式返回原值更清晰）

## Decision Hook

唯一的 Decision hook：**`shouldContinue`**

参与「是否继续 tool-call 循环」的决策。

```ts
export const createInterruptionFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'interruption',
  shouldContinue: (ctx, step) => {
    if (!step.hasToolCalls || !step.anyRequiresFollowUp) return undefined; // 弃权
    if (hasPendingRuntimeEvent) return false;  // 停止
    return undefined;  // 弃权
  },
});
```

语义：
- `true` → 强制继续（覆盖前面的 `false`）
- `false` → 请求停止
- `undefined` → 弃权（保持之前的结论）
- 最后一个非 `undefined` 的返回值生效

## Feature 间通信

Feature 之间不直接引用。通过共享的可变结构通信：

| 通道 | 生命周期 | 典型数据 |
|------|----------|----------|
| `ctx.turn` (`TurnState`) | 整个 turn | `.entries`, `.tools`, `.system`, `.capabilities`, `.flags` |
| `ctx.scratch` (`TurnScratch`) | 整个 turn | `.contextEstimatedTokens`, `.recentSendMessageHumanLikenessXml` |
| `deps.*` 信号 | 跨 turn | `rc()`, `running()`, `lastProcessedMs()`, `offline()` |

新增 feature 间传递数据：
- 生命周期 = 当前 turn → 加字段到 `TurnScratch`
- 生命周期 = 跨 turn → 加到 `TurnState` 或 deps 信号

## 添加外部依赖

1. 在 `MainTurnFeatureDeps`（`types.ts`）中添加字段
2. 在 `createDriver` 的 `createMainTurnFeatures(...)` 调用处传入
3. 在 feature 工厂中从 `deps` 读取

不要在 feature 内部直接 import 外部模块的实例 — 所有外部依赖通过 `deps` 注入。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 准备阶段抛 `TurnPreparationSkipped` | turn 安静退出，不触发 `failTurn` |
| 准备阶段抛其他错误 | `failTurn` + `cleanupTurn` |
| 步骤循环中 abort | turn 中断退出，只跑 `cleanupTurn` |
| 步骤循环中普通异常 | `failTurn` + `cleanupTurn` |

指导原则：
- Effect hook 中可以安全地 throw — 外层会 catch
- Transform hook 中不要 throw — 会导致步骤数据丢失，做好防御性检查
- `failTurn` 中不要 throw — 否则后续 feature 的 `failTurn` 不会执行

## 完整示例

添加一个「速率限制」Feature — 10 秒内已发 3 条消息则跳过本次 turn：

```ts
// src/driver/features/rate-limit.ts
import type { DriverFeature } from '../turn-features';
import { TurnPreparationSkipped } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

const WINDOW_MS = 10_000;
const MAX_SENDS = 3;

export const createRateLimitFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'rate-limit',
  prepareTurn: async ctx => {
    const trs = await deps.loadTRs(deps.chatId);
    const now = Date.now();
    const recentCount = trs.filter(t => now - t.requestedAtMs < WINDOW_MS).length;
    if (recentCount >= MAX_SENDS) {
      deps.log.withFields({ chatId: deps.chatId, recentCount }).log('Rate limited');
      throw new TurnPreparationSkipped('Rate limit exceeded');
    }
  },
});
```

注册位置 — 尽早拦截，放在 context 之前：

```ts
export const createMainTurnFeatures = (deps: MainTurnFeatureDeps): DriverFeature[] => [
  createRateLimitFeature(deps),  // ← 最早检查
  createContextFeature(deps),
  // ...
];
```

## 当前 Feature 编排顺序

| # | Feature | 职责摘要 |
|---|---------|----------|
| 1 | context | 加载历史 TR + 压缩摘要，compose `turn.entries` |
| 2 | interruption | `shouldContinue`: runtime event 到达时停在步骤边界 |
| 3 | reaction | 刷新可用 emoji 列表 |
| 4 | capability | 设置 `turn.capabilities` |
| 5 | tools | 根据 capabilities 组装 `turn.tools` |
| 6 | skill | 注入 skill catalog 到系统提示词 |
| 7 | human-likeness | 收集最近 send_message 的格式反馈 XML |
| 8 | prompt | 渲染 velin 模板 → `turn.system` + late-binding |
| 9 | logging | dump request JSON 到 /tmp |
| 10 | mailbox | 检查 subagent 邮箱消息 |
| 11 | send-message | `transformStepEntries`: 裁剪长度限制失败 |
| 12 | persistence | `persistStep`: 写 `turn_responses_v2` |
| 13 | failure | `failTurn`: 标记 `failedRc` 防止 effect 死循环 |
| 14 | cleanup | `cleanupTurn`: 重置 `running`、更新 `lastProcessedMs` |

## Checklist

新建 feature 前过一遍：

- [ ] 确定需要哪些 hook — 只实现需要的
- [ ] 确定数组位置 — 它依赖谁？谁依赖它？
- [ ] 通过 `TurnState`/`TurnScratch` 通信 — 不跨 feature 直接调用
- [ ] 需要新 deps？修改 `MainTurnFeatureDeps`
- [ ] Transform hook 永远返回值，Decision hook 不确定时返回 `undefined`
- [ ] 需要释放资源？用 `cleanupTurn`
- [ ] 写测试：feature 工厂返回普通对象，可直接构造 mock deps 单测每个 hook
