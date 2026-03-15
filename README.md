<p align="center">
  <img src="assets/icon.svg" width="200" height="200" alt="Cahciua">
</p>

<h1 align="center">Cahciua</h1>

<p align="center">
  基于 Deterministic Context Pipeline (DCP) 架构的 Telegram 群聊 AI Bot<br>
  <a href="https://github.com/memohai/Memoh">Memoh</a> 的研究性附属项目
</p>

---

Cahciua 是一个 Telegram 群聊机器人，通过 LLM 自主决定何时参与对话并生成回复。

## 特性

- **DCP 三层流水线** — Adaptation → Projection → Rendering，确定性地将平台事件转化为 LLM 上下文
- **自主回复决策** — Bot 通过 tool call 决定是否回复，而非被动触发
- **KV Cache 友好** — append-only 历史、静态 system prompt、基于 epoch 的压缩设计
- **消息防注入** — XML fencing 隔离用户消息内容，防止 prompt injection

## 技术栈

TypeScript · Node.js· grammY · gramjs · xsAI · SQLite (Drizzle ORM) · Immer · Valibot

## 开始使用

本项目提供了完善的 [`AGENTS.md`](AGENTS.md)，推荐使用 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://openai.com/index/introducing-codex/) 等 coding agent 来调研、理解和使用本项目。

```bash
# 克隆项目后，直接在项目目录启动 coding agent 即可
claude   # Claude Code
codex    # OpenAI Codex
```

Coding agent 会自动阅读 `AGENTS.md` 中的架构文档，理解项目结构与设计决策，并协助你完成配置、开发和调试。
