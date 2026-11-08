# AGENTS.md

给 coding agent 的作业约束。产品行为、API 事实、设计意图都在代码里；这里只写「不能改什么」和「改之前必须知道什么」。

Chrome MV3 侧的扩展：在侧栏或网页悬浮入口写 Markdown，连同当前页面链接写入 Heptabase（官方 MCP 端点 + OAuth PKCE，无自建服务器）。

## 硬约束

- **零构建**。原生 ES modules，无 npm、无打包器、无框架。任何改动都要保证「解压目录直接 load unpacked」可用。
- **token 只在 background**。OAuth 与 MCP 调用全部经 `background.js`，UI 层通过 `chrome.runtime.sendMessage` 请求。`chrome.storage.local` 用 `setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` 隔离，content script 读不到 token。
- **编辑器存取值必须无损**。`sidepanel/md-editor.js` 可以用受控 span 隐藏 block 语法，但 `getValue()` / `setValue()` 必须 markdown roundtrip；每次 DOM 重建都要按纯文本 offset 保存并恢复选区，光标不许跳。
- **悬浮编辑器不能进 iframe**。扩展 iframe 会给每个打开的网站多出一个 Inspect view。编辑器是 light DOM 的 `contenteditable`，被 slot 进 Shadow DOM 里的 sheet；`textarea` 只作为草稿/send 的承载值。
- **写入绝不自动重试**。MCP 结果未知（超时、SW 被杀、响应丢失）时保留草稿并展示失败态，因为服务端可能已经写入了。
- 不新增 ROADMAP / TODO / STATUS 类文件。文档只维护本文件和 README。

## 文件地图

```
manifest.json             MV3；sidePanel/tabs/storage/clipboardWrite/scripting
background.js             消息路由 + OAuth + MCP 调用 + install 时向已开标签注入悬浮入口
lib/oauth.js              PKCE S256 + 动态注册 + refresh
lib/mcp-client.js         JSON-RPC POST /mcp，响应兼容 JSON 与 SSE
lib/capture-content.js    悬浮模式 → MCP 工具调用的唯一映射
lib/capture-store.js      chrome.storage.local 里的持久草稿（tab ID + mode 为键）
sidepanel/panel.html      两个视图：#editor-view（已连接）/ #connect-view（未连接）
sidepanel/panel.js        tab 跟踪、模式切换、草稿、发送状态机
sidepanel/md-editor.js    两端共用的 Markdown 编辑器（normalize / getValue / setValue）
sidepanel/panel.css       设计 token 在 :root；暗色走 prefers-color-scheme
floating/floating.js      悬浮控制：dock、sheet、pin、关闭
floating/floating.css     Shadow DOM 样式
floating/editor-inline.css  编辑器样式，manifest CSS + scripting.insertCSS 双注入
floating/icons.js         Reicon BoldDuotone 图标集（MIT）
```

## 必须保持的产品行为

- **模式映射**（`lib/capture-content.js` 是唯一出口）：Journal 和 Link 追加到当天 Journal；Note 走 `create_object`；Todo 写一条未勾选的 Markdown 清单项到当天 Journal。官方 MCP 目前**不能**创建 Task App Todo，这个限制要在用户文档里保持可见。
- **草稿归属**：一条草稿按 tab ID + mode 落盘，含 `revision`。确认发送成功只清掉已提交的那个 revision；用户在请求期间又改了内容，新内容必须留下。
- **Append 日期**：`append_to_journal` 必须显式传本地日期 `date: YYYY-MM-DD`，否则服务端时区可能写错天。
- **侧栏草稿**走 `chrome.storage.local`，首次打开时把旧的 `chrome.storage.session` 草稿迁移过来。
- **`captureOpenSidePanel` 必须同步调用 `chrome.sidePanel.open()`**。先等 storage 访问屏障会丢掉 Dia 的用户手势，面板打不开。
- **install/update 注入**：`background.js` 用 `scripting.executeScript` 给已开的 HTTP/HTTPS 标签注入悬浮入口，避免静态注册在重载解压扩展后让旧标签空白；替换旧 DOM host 时要保留「刷新前隐藏」状态。

## 视觉与排版

两端编辑器共用同一套 Atlas 排版，字体走用户系统栈：base 14.5px、行高 1.75、measure 36em，标题比例 1.55 / 1.3 / 1.12，标题上 margin .65em、下 .3em，首行不加 top margin。侧栏沿用悬浮控制的视觉语言：Reicon duotone 模式图标、来源 chip + 编辑器合成一张 glass 卡、superellipse 外边角、hairline 阴影、按钮 Add → Adding → Sent 反馈。

视觉不要自由发挥。改 UI 前先确认对应设计稿，不确定就问。

## 踩过的坑

- `chrome.identity.launchWebAuthFlow` 的弹窗会丢 OAuth 会话 cookie，授权页直接 500。授权必须开普通标签页（`launchAuthTab`），不要改回去。
- MCP 响应实测总是 SSE（`data:` 行），解析要同时兼容两种 content-type。
- Heptabase 动态注册会静默丢弃 `logo_uri`，授权页图标改不了，别再试。
- client_id 与注册时的 `redirect_uri`、`client_name` 绑定存储；任一变就会重注册，用户要重新授权一次。
- CSS 的 `display:flex` 会压过 HTML `hidden` 属性，全局有 `[hidden]{display:none!important}` 兜底；新视图规则别绕开它。
- MV3 service worker 空闲约 30s 被杀。授权等待期间有 keep-alive ping；面板侧 `send()` 已兜底 undefined 响应，新消息类型沿用该封装。
- 悬浮草稿被中断（登录中断、页面刷新、切换 tab）后要能恢复：先按 tab 匹配，再退到同 URL + 同 mode 的最新草稿；不能覆盖另一条不同草稿，要让用户选。

## 开发与验证

- **语法**：`node --check` 改动过的 JS（ESM 需复制成 `.mjs`），并 parse 一次 `manifest.json`。
- **单测**：`node --test tests/capture.test.mjs`（数据丢失与内容拼装路径）、`node --test tests/background.test.mjs`（service worker 路由）。后者用 stub `chrome.*` 为每个用例重新导入一份 worker，所以生命周期与消息路径互不污染。
- **编辑器**：起本地静态服务器打开 `tests/runtime-harness.html`（stub `chrome.*` 后加载真实 `panel.js` / `panel.css`），真实打字验证渲染和光标，别只看代码。
- **扩展本体**：`chrome://extensions` 重载解压目录。涉及授权或真实保存的改动，让用户在自己浏览器里操作并回报结果。
- **不做真实写入测试**。需要确认写入结果时只读回看，不要为了测试往用户 Heptabase 里写东西。
- API 行为存疑时先写探针打真实端点（注册 → PKCE → `tools/call`），不要在插件里盲调。

## 提交

一次一件事，atomic commit，类型前缀 `feat/fix/refactor/docs/chore`。改动涉及用户可见行为时同步更新 README 与 README.zh.md。
