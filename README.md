<p align="center">
  <img src="assets/edelweiss.jpg" width="200" height="200" alt="Edelweiss">
</p>

<h1 align="center">Edelweiss ❄️</h1>

<p align="center">
    基于<img style="display: inline; height: 1rem" src="assets/cahciua.svg" /><a href="https://github.com/Menci/Cahciua">Cahciua</a> 二次开发的 Agentic AI 聊天机器人
</p>

---

[Edelweiss](https://t.me/IcyEdelweissBot) 是一个 Telegram / QQ 群聊机器人，基于 Cahcuia 二次开发，通过 LLM 自主决定何时参与对话并生成回复。

## DCP — Deterministic Context Pipeline

> 「如果人生的上下文可以倒带，可否让我用无尽的重载，去编排那个完美的未来？」

作为 Cahciua 的核心架构，DCP 是一条纯函数流水线，将平台事件确定性地转化为 LLM 上下文：

1. **Adaptation** — 将从 IM（Telegram）收到的事件转换为平台无关的（Canonical IM Event）
2. **Projection** — 纯函数 reducer，将事件流归约为结构化的中间上下文（Intermediate Context）
3. **Rendering** — 将 Intermediate Context 序列化为分段的、provider 无关的 XML 渲染上下文（Rendered Context）
4. **Driver** — 有状态的编排层，将 Rendered Context 与历史对话轮次（Turn Responses）按时间线合并，通过监视条件触发副作用来执行 LLM 调用

不维护上下文，而是维护上下文的构造过程 —— 任何一部分都可以单独运行测试，甚至用于在备好的数据集上评测与迭代。冷启动重放与实时处理能够产生相同的上下文序列。  
—— 这就是 *Deterministic* 的含义

## Cahciua 核心特性

- **DCP 四层流水线** — Adaptation → Projection → Rendering → Driver，通过外部事件和历史轮次编排出确定的 LLM 上下文
- **自主回复决策** — Bot 通过 tool call 决定是否回复，而非被动触发
- **KV Cache 友好** — append-only 历史、静态 system prompt、基于 epoch 的压缩设计
- **消息防注入** — XML fencing 隔离用户消息内容，防止 prompt injection
- **类人检查** — 在系统提示词里引导 LLM 采用类似真实人类的打字风格，系统时刻检查 LLM 的发送内容并对其进行指引

## 对比 Cahciua 的新特性

- 完整的 OneBot v11 协议支持，可通过 NapCat 接入 QQ 平台
- 针对 DeepSeek V4 系列模型优化，加入 `reasoning_effort`、图片转文字像素预算等设置选项，并在类人检查中加入「确实」频率检查（「确实」是该模型的口癖）
- 支持添加自定义系统提示词（IDENTITY.md 等），并可根据不同平台使用不同提示词片段
- 为 Telegram 平台设计防抖功能，监听「正在输入」事件，在用户发送多条消息或群里正在激烈讨论时，不触发 LLM 调用，防止 Bot 不合时宜地插嘴
- 初步支持技能文件，用户可以引导 Bot 把成形的工作流记录为技能文件，供以后参考
- 初步支持 subagent，Bot 可以把消耗上下文的任务（如复杂的探索任务）委派给 subagent，防止多余 TR 干扰对话方向
- 可选的 rtk 集成（`tools.bash.compactOutput`），通过 [rtk](https://github.com/rtk-ai/rtk) 压缩 bash 工具输出，节省 LLM 上下文 token

## 开始使用

本项目提供了完善的 [`AGENTS.md`](AGENTS.md)，推荐使用 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://openai.com/index/introducing-codex/) 等 coding agent 来调研、理解和使用本项目。

```bash
# 克隆项目后，直接在项目目录启动 coding agent 即可
claude   # Claude Code
codex    # OpenAI Codex
```

Coding agent 会自动阅读 `AGENTS.md` 中的架构文档，理解项目结构与设计决策，并协助你完成配置、开发和调试。
