<div align="center">
  <img src="assets/icon.png" alt="PDFTrim for LLM icon" width="112" />
  <h1>PDFTrim for LLM</h1>
  <p><strong>Token 很贵，请别浪费。</strong></p>
  <p>保留正文，减少噪声，把上下文窗口留给真正重要的部分。</p>
  <p>
    <a href="../README.md">English</a> |
    <a href="README-zhCN.md">简体中文</a>
  </p>
</div>

<div align="center">

[![Zotero 7-8](https://img.shields.io/badge/Zotero-7%20%7C%208-green?style=for-the-badge&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![GitHub release](https://img.shields.io/github/v/release/ShengjieJin/pdftrim-for-llm?style=for-the-badge)](https://github.com/ShengjieJin/pdftrim-for-llm/releases)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=for-the-badge)](../LICENSE)

</div>

---

## 🔥 News

- `v0.1.0` 首个公开版本，支持 Zotero 7/8、PDF 分割导出、侧边栏打开结果，以及一键清理生成文件。

## ✨ 项目动机

在很多论文中，真正需要交给 LLM 的，往往只有正文部分。

但现实里的 PDF 通常还包含冗长的 `References`、附录、提示词、伪代码、ablation、implementation details 等内容。对于人工阅读来说，这些信息当然有价值；可一旦进入 LLM 工作流，它们往往只会带来三个问题：

- 消耗更多 tokens
- 引入更多无关噪声
- 挤占正文可用的上下文空间

`PDFTrim for LLM` 正是为这个具体且高频的场景而设计的：

当你在 Zotero 中阅读论文，准备将其交给 LLM 时，不必再手动导出、裁页、重命名，再重新挂回条目。插件会帮你把这套重复操作尽可能简化，让你更顺畅地进入后续的阅读和分析流程。

这个需求在很大程度上受到 [llm-for-zotero](https://github.com/yilewang/llm-for-zotero) 和 [Vibero](https://github.com/chenyu-xjtu/Vibero) 的启发。它们让“在 Zotero 中直接结合 LLM 进行 vibe reading”这一使用场景变得非常清晰；而这个插件则专注解决其中一个小而反复出现的痛点：在将论文交给模型之前，先裁掉那些最消耗 tokens 的后置内容。

本项目基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 开发。

## 🧩 主要功能

- 自动检测 `References` 起始页
- 推断 `Appendix` 起始页
- 支持人工确认和修改页码
- 在原 PDF 同目录生成适合发给 LLM 的新 PDF
- 保留原始 PDF 不变
- 自动把生成结果附加回同一个 Zotero 条目
- 支持在侧栏直接打开或删除生成结果

## ⚠️ 检测准确性

当前分割位置的检测基于启发式规则，**并不保证每次都完全准确**。

在导出之前，建议始终：

- 检查 `References start page`
- 检查 `Appendix start page`
- 使用 `Jump` 手动确认对应页面
- 如有偏差，手动修改页码

这个插件的目标是减少重复劳动，而不是替代人工确认。

## 🖼️ 截图

| 自动定位 PDF 中的 Reference 和 Appendix | 点击 `jump` 可直接跳转到对应页码；若定位结果不够准确，也支持手动微调 |
| --------------------------------------- | -------------------------------------------------------------------- |
| ![Sidebar placeholder](assets/1.png)    | ![Detection placeholder](assets/2.png)                               |

| 点击 `Split PDF` 可一键分割 PDF；点击 `Open PDF` 可直接打开分割后的文件 | 在将分割后的正文 PDF 与 LLM 交互完成后，可点击 `Delete Generated PDFs` 一键清理所有生成文件 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Preview placeholder](assets/3.png)                                    | ![Attachments placeholder](assets/4.png)                                                    |

## 📦 安装方式

1. 从 [GitHub Releases](https://github.com/ShengjieJin/pdftrim-for-llm/releases) 下载最新 `.xpi`
2. 打开 Zotero
3. 进入 `Tools -> Plugins`
4. 把 `.xpi` 拖入插件窗口安装
5. 如有需要，重启 Zotero

发布文件通常类似：

```text
pdf-trim-for-llm.xpi
```

## 🚀 使用方式

1. 在 Zotero 中打开一篇 PDF
2. 在右侧边栏打开 `PDFTrim for LLM`
3. 等待自动检测完成
4. 检查：
   - `References start page`
   - `Appendix start page`
5. 点击 `Jump` 跳转确认
6. 如有需要，手动调整页码
7. 选择模式：
   - `Extract Main Text`
   - `Split into Sections`
8. 点击 `Split PDF`

生成后的 PDF 会保存在原文件同目录，并自动附加到同一个 Zotero 条目下。

## 📄 输出规则

原文件：

```text
paper.pdf
```

`Extract Main Text` 会生成：

```text
paper-main.pdf
```

`Split into Sections` 会生成：

```text
paper-main.pdf
paper-reference.pdf
paper-appendix.pdf
```

原始 PDF 不会被修改。

## 🛠️ 开发

环境要求：

- Node.js LTS
- Git
- Zotero 7 或 Zotero 8

启动开发：

```bash
npm install
npm start
```

正式构建：

```bash
npm run build
```

构建产物位于：

```text
.scaffold/build/
```

## 🧱 仓库说明

当前仓库已经配置好：

- GitHub Releases
- `update.json` / `update-beta.json`
- Zotero `.xpi` 打包

## ⚖️ 许可协议

本项目采用 `AGPL-3.0-or-later` 许可。

## 🙏 致谢

- [llm-for-zotero](https://github.com/yilewang/llm-for-zotero)
- [Vibero](https://github.com/chenyu-xjtu/Vibero)
- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
