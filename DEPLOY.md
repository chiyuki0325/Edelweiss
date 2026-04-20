# Cahciua 部署指南

本文档面向需要自行部署 Cahciua（或其 fork Edelweiss）的用户。

---

## 环境要求

- **Node.js** >= 22
- **pnpm**（包管理器）
- **SQLite**（由 better-sqlite3 内嵌，无需单独安装）
- **系统依赖**（仅在启用动画转文字功能时需要）：
  ```bash
  apt-get install -y libpng-dev librlottie-dev
  ```

## 准备 Telegram 凭据

部署 Cahciua 需要两套 Telegram 凭据：

### 1. Bot Token（必须）

在 Telegram 中与 [@BotFather](https://t.me/BotFather) 对话，创建一个新 Bot，获得形如 `123456789:ABCDEF...` 的 Bot Token。

### 2. User API 凭据（必须）

User API 用于获取消息历史、解析回复链，以及接收编辑/删除事件。

1. 前往 [my.telegram.org](https://my.telegram.org)，登录后进入 **API development tools**。
2. 创建应用，记录 `api_id`（数字）和 `api_hash`（字符串）。

### 3. MTProto Session（必须）

Session 字符串用于让 User API 客户端免于每次重启都重新登录。

克隆项目并安装依赖后，运行交互式登录脚本：

```bash
pnpm login
```

按提示输入手机号和验证码完成登录，脚本会输出 Session 字符串，将其填入配置文件。

## 安装与配置

### 1. 安装依赖

```bash
pnpm install
```

### 2. 创建配置文件

复制示例配置：

```bash
cp config.example.yaml config.yaml
```

### 3. 编辑 config.yaml

以下是各配置项说明：

#### `models` — LLM 模型注册表

```yaml
models:
  primary:
    apiBaseUrl: "https://api.anthropic.com"   # API 端点（兼容 OpenAI 格式的任意提供商）
    apiKey: "sk-ant-..."                       # API 密钥
    model: "claude-opus-4-6"                  # 模型名称
    reasoningSignatureCompat: "anthropic"      # 推理签名兼容组，同提供商填相同值
    # apiFormat: "openai-chat"                 # 可选：'openai-chat'（默认）或 'responses'
    # timeoutSec: 120                          # 可选：请求超时秒数
    # maxImagesAllowed: 100                    # 可选：每次请求最多携带的图片数量
  probe:
    apiBaseUrl: "https://api.anthropic.com"
    apiKey: "sk-ant-..."
    model: "claude-haiku-4-5"
    reasoningSignatureCompat: "anthropic"
```

`models` 是一个键值表，键名可以自定义（如 `primary`、`probe`），在 `chats` 配置中通过键名引用。

#### `telegram` — Telegram 凭据

```yaml
telegram:
  botToken: "123456789:ABCDEF..."  # BotFather 给出的 Bot Token
  apiId: 12345678                   # my.telegram.org 的 api_id
  apiHash: "abcdef1234567890..."    # my.telegram.org 的 api_hash
  session: "1BVtsOK8..."           # pnpm login 输出的 Session 字符串
```

#### `database` — 数据库路径

```yaml
database:
  path: "./data/cahciua.db"   # SQLite 数据库文件路径（目录不存在时自动创建）
```

#### `runtime` — 工具运行时（可选）

```yaml
runtime:
  shell: ["/bin/bash", "-c"]   # bash 工具的命令前缀
  # writeFile: ["/bin/bash", "-c", "/usr/bin/cat > \"$0\""]  # 启用 download_file 工具所需
  # readFile: ["/usr/bin/cat"]  # 启用本地路径 read_image / send_message 附件所需
```

#### `chats` — 聊天会话配置

`chats.default` 为所有会话的默认配置，其余键为聊天 ID 白名单（同时作为该聊天的配置覆盖项）：

```yaml
chats:
  default:
    model: "primary"            # 引用 models 中的键名
    compaction:
      enabled: true             # 是否启用上下文压缩
      maxContextEstTokens: 512000   # 触发压缩的上下文估算 token 上限
      workingWindowEstTokens: 8000  # 压缩后保留的原始内容 token 量
      dryRun: false             # true = 仅演练，不实际持久化压缩结果
    probe:
      enabled: false            # 是否启用 Probe 模式（群聊节省 token）
      model: "probe"
    imageToText:
      enabled: false            # 是否在入队前将图片转为文字描述
      model: "primary"
    animationToText:
      enabled: false            # 是否将 GIF/动态贴纸转为文字描述
      model: "primary"
      # maxFrames: 5
    customEmojiToText:
      enabled: false            # 是否将自定义 emoji 转为文字描述
      model: "primary"
    features:
      trimStaleNoToolCallTurnResponses: false
      trimSelfMessagesCoveredBySendToolCalls: false
      trimToolResults: false
    tools:
      readImage:
        enabled: false
      # bash:
      #   enabled: false
      # downloadFile:
      #   enabled: false        # 需要配置 runtime.writeFile
      # webSearch:
      #   enabled: false
      #   tavilyKey: ""         # Tavily API 密钥

  # 白名单示例（聊天 ID 来自 Telegram，群组为负数，私聊为正数）：
  # "-1001234567890": {}                  # 使用全部默认配置
  # "-1001234567890":                     # 覆盖部分配置
  #   model: "secondary"
```

**获取聊天 ID**：将 Bot 加入群组后发送消息，在日志中可见聊天 ID；或使用 [@userinfobot](https://t.me/userinfobot) 等工具查询。

---

## 功能说明

### Probe 模式（群聊节省成本）

当 Bot 未被 @ 或回复时，先用一个小模型（probe）判断是否需要响应。若 probe 认为无需回复，则跳过大模型调用，大幅减少 token 消耗。建议在群聊中开启。

### 上下文压缩（Compaction）

当对话历史超过 `maxContextEstTokens` 阈值时，自动调用 LLM 对历史内容进行摘要，保留最近 `workingWindowEstTokens` 的原始内容，防止上下文溢出。

### 图片 / 动画 / Emoji 转文字

将图片、GIF、动态贴纸、自定义 emoji 转换为文字描述后再送入 LLM 上下文，让不支持视觉的模型也能理解多媒体内容，同时减少 token 消耗。

启用动画相关功能需要系统安装 `libpng-dev` 和 `librlottie-dev`。

---

## 运行

### 开发模式（文件变动自动重启）

```bash
pnpm dev
```

### 生产模式

```bash
pnpm start
```

### 构建产物后运行

```bash
pnpm build
node dist/index.js
```

日志默认以 pretty 格式输出；若需 JSON 格式（适合日志收集系统），设置环境变量 `NODE_ENV=production`：

```bash
NODE_ENV=production pnpm start
```

配置文件路径默认为 `config.yaml`，可通过环境变量覆盖：

```bash
CONFIG_PATH=/etc/cahciua/config.yaml pnpm start
```

---

## 数据目录

运行后会自动创建以下目录和文件：

| 路径 | 说明 |
|------|------|
| `./data/cahciua.db` | SQLite 数据库（事件、消息、对话轮次等） |
| `/tmp/cahciua/<chatId>.request.json` | 每次 LLM 请求前的完整请求体（调试用） |

---

## 常见问题

**Bot 没有回复群组消息**

检查 `config.yaml` 中 `chats` 是否添加了该群组 ID，未在白名单中的聊天会被忽略。

**动画/贴纸转文字报错**

确认系统已安装 `libpng-dev` 和 `librlottie-dev`，并重新执行 `pnpm install`（需重新编译 `lottie-frame` 原生模块）。

**MTProto 登录失败 / Session 失效**

重新运行 `pnpm login` 获取新的 Session 字符串并更新 `config.yaml`。

**Bot 无法看到其他 Bot 的消息**

其他 Bot 的消息仅能通过 User API（gramjs）接收，确保 `telegram.session` 已正确配置且账号在该群组中。
