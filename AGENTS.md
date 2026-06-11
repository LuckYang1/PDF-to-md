# AGENTS.md

- 始终用中文回复。
- 本项目是 Zotero 插件 `PDF to Markdown`，不是原始 `zotero-plugin-template` 示例仓库。
- 插件 ID：`pdf-to-md@local`。
- 偏好前缀：`extensions.zotero.pdftomd`。
- 开发启动：`npm start`。
- 构建：`npm run build`，产物在 `.scaffold/build/pdf-to-markdown.xpi`。
- 检查：`npm run lint:check`。
- 本地 API 默认地址为 `http://127.0.0.1:8002`，直连 API 通常为 `http://127.0.0.1:8000`。
- 主要实现位于 `src/modules/pdfToMd.ts` 和 `src/modules/renderHtml.ts`。
- `src/modules/pdfToMd.ts` 使用 Zotero/XPCOM 运行时 API 较多，
  当前保留 `@ts-nocheck` 和 ESLint 例外；
  修改时优先保证 Zotero 运行时行为。
