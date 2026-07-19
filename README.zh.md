# Side Heptabase

English: [README.md](README.md)

<p align="center">
  <img src="icons/icon512.png" width="96" height="96" alt="Side Heptabase logo">
</p>

我做 Side Heptabase，是给那些在 Chrome 里阅读、研究，又希望笔记直接落进 Heptabase 的人。记下想法、保留来源、选择落点，每一步都不难，但一天重复几十次就会打断注意力。这个插件把我在真实浏览场景里反复使用的工作流收进一个侧栏。AI 可以加速整理笔记，但它不会代替「什么值得留下」的专业判断；顺手的捕捉工具能把这种判断进一步放大。

Side Heptabase 是一个非官方 Chrome 侧栏插件：用 Markdown 写笔记，直接新建 Heptabase Note Card 或追加到当天 Journal，并自动附上当前页面标题与 URL 作为来源。

<p align="center">
  <img src="assets/side-heptabase-preview.png" width="520" alt="Chrome 侧栏中打开的 Side Heptabase 编辑器">
</p>

## 安装

Side Heptabase 目前以 Chrome unpacked extension 运行，不需要构建，也没有 package 依赖。

1. 下载或 clone 本仓库。
2. 在 Chrome 打开 `chrome://extensions`。
3. 开启右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择本仓库目录。
5. 点击 Side Heptabase 插件图标，打开侧栏。
6. 点击**连接 Heptabase**，在新标签页完成授权。

## 使用

1. 打开想要记录的网页。
2. 在侧栏中用 Markdown 写笔记。
3. 选择 **Note Card** 或 **Journal**。
4. 点击 **Send**，或按 `Cmd/Ctrl + Enter`。

发送到 Note Card 时，如果笔记以 H1（`#`）开头，会保留它作为卡片标题；否则插件会在开头补上当前页面标题。当前页面的标题与 URL 会作为来源链接追加在笔记末尾。草稿和目标类型会在当前浏览器会话中保留，重新打开侧栏也不会丢失。

## 权限与隐私

- `sidePanel`：在 Chrome 侧栏中显示编辑器。
- `tabs`：读取当前页面标题与 URL，并将其附在笔记中作为来源。
- `storage`：在 Chrome 中保存 OAuth 会话与未发送草稿。
- `api.heptabase.com`：完成 Heptabase 授权和笔记写入。

笔记由插件直接发送到 Heptabase。OAuth token 只保存在 Chrome extension storage 中，并且只由 background service worker 处理，不会进入侧栏页面。本项目不运行任何中转服务器。

Side Heptabase 是社区项目，与 Heptabase 官方无隶属或背书关系。

## 项目结构

```text
assets/       README 截图
icons/        插件图标与 README logo
lib/          OAuth 与 Heptabase MCP client
sidepanel/    侧栏界面与 Markdown 编辑器
background.js Background service worker 与消息路由
manifest.json Chrome Manifest V3 配置
```

## 限制

- 目前只能通过 Chrome 的**加载已解压的扩展程序**手动安装，尚未发布到 Chrome Web Store。
- 目前支持纯 Markdown 文本，不支持文件或图片附件。
- 重新安装插件或移动仓库目录可能改变 extension ID，需要重新授权 Heptabase。
- 依赖 Chrome side panel 与 extension storage API，暂未支持或测试其他浏览器。

## License

[MIT](LICENSE)
