# PDF to HTML - Academic Paper Converter

纯静态的学术论文 PDF → 结构化 HTML 转换工具。

## 特性

- **零依赖安装** — 全部通过 CDN 加载，无需 npm/构建
- **学术论文优化** — 针对 ACM/IEEE 会议论文排版
- **自动布局检测** — 识别单栏/双栏排版
- **结构化输出** — 自动提取标题、作者、摘要、章节、参考文献
- **三种导出** — 预览 / HTML 源码 / 独立 HTML 文件
- **对比模式** — 原始 PDF 与转换结果并排对比

## 部署到 GitHub Pages

```bash
# 1. 创建 GitHub 仓库
gh repo create pdf2html --public

# 2. 初始化并推送
git init
git add .
git commit -m "init: pdf2html academic paper converter"
git remote add origin git@github.com:<your-username>/pdf2html.git
git branch -M main
git push -u origin main

# 3. 启用 GitHub Pages
# Settings → Pages → Source: Deploy from branch → Branch: main / (root)
# 访问: https://<your-username>.github.io/pdf2html/
```

## 技术栈

| 依赖 | 版本 | 用途 |
|------|------|------|
| PDF.js | 3.11.174 | PDF 解析与文本提取 |
| Highlight.js | 11.9.0 | HTML 源码高亮 |
| FileSaver.js | 2.0.5 | 文件下载 |

全部通过 cdnjs.cloudflare.com CDN 加载。

## 转换流程

1. PDF.js 逐页提取文本项（含坐标、字号、字体信息）
2. 按 y 坐标聚合为行，按行间距聚合为段落块
3. 自动检测栏数（单栏 vs 双栏）
4. 识别文档结构：标题 → 作者 → 摘要 → 章节 → 参考文献
5. 生成语义化 HTML + 学术论文 CSS 样式

## 使用

直接浏览器打开 `index.html`，拖入 PDF 即可转换。
