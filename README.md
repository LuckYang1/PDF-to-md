# PDF to Markdown

<p align="center">
  <img src="addon/content/icons/pdf-to-md-zotero-icon.svg" alt="PDF to Markdown icon" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/LuckYang1/PDF-to-md/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/LuckYang1/PDF-to-md/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/LuckYang1/PDF-to-md/releases"><img src="https://img.shields.io/github/v/release/LuckYang1/PDF-to-md?label=Release" alt="Release"></a>
  <a href="https://github.com/LuckYang1/PDF-to-md/blob/main/LICENSE"><img src="https://img.shields.io/github/license/LuckYang1/PDF-to-md" alt="License"></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-red" alt="Zotero 7+">
  <img src="https://img.shields.io/badge/MinerU-supported-blue" alt="MinerU supported">
</p>

<!-- README-I18N:START -->

**English** | [中文](./doc/README-zhCN.md)

<!-- README-I18N:END -->

PDF to Markdown is a Zotero plugin that converts PDF attachments in Zotero
items to Markdown or HTML, with optional attachment export.

Conversion is powered by MinerU and supports three modes:

- Token API: use `https://mineru.net/api/v4` after entering a MinerU API Token.
- Light mode: use the MinerU light API when no token is configured and local API
  mode is disabled.
- Local API: use a local MinerU API / Router. The default Router address is
  `http://127.0.0.1:8002`.

## MinerU Resources

- Local deployment:
  [MinerU README_zh-CN.md](https://github.com/opendatalab/MinerU/blob/master/README_zh-CN.md).
- API application and documentation:
  [MinerU API Manage Docs](https://mineru.net/apiManage/docs).

## Tags

`zotero` `zotero-plugin` `pdf` `markdown` `html` `mineru` `auto-update`

## Features

- Run actions from the `PDF to Markdown` submenu on Zotero items or PDF
  attachments.
- Convert PDFs to Markdown with `Convert to Markdown (MinerU)`.
- Convert PDFs to HTML with `Convert to HTML (MinerU)`.
- Choose a specific PDF when a Zotero item contains multiple PDF attachments.
- Save conversion results back to the original Zotero item as attachments.
- Keep Markdown image links usable by copying the companion `images/` folder.
- Build HTML from MinerU ZIP Markdown first, then embed images as data URLs.
- Automatically convert newly added PDFs to Markdown.
- Export attachments to the default output folder or a temporary folder chosen at
  runtime.
- Show conversion progress in a bottom-right panel, with minimize and restore
  support from the context menu.

## Installation and Development

This repository is based on `zotero-plugin-scaffold`.

Install dependencies:

```powershell
npm install
```

Start development mode:

```powershell
npm start
```

The local `.env` file can point to an isolated Zotero development profile. Use
`.env.example` as the template.

Build the XPI:

```powershell
npm run build
```

The build artifact is generated at:

```text
.scaffold/build/pdf-to-markdown.xpi
```

Run static checks:

```powershell
npm run lint:check
```

## Auto Update and Releases

The plugin manifest includes an update URL generated at build time:

```text
https://github.com/LuckYang1/PDF-to-md/releases/download/release/update.json
```

Publishing a `v*` tag triggers the GitHub Actions release workflow. The workflow
builds the XPI, publishes it to the versioned GitHub Release, and refreshes the
`update.json` asset on the fixed `release` tag so Zotero can discover updates.

Example:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

## Settings

Open `PDF to Markdown` in Zotero preferences:

- `API Token`: MinerU Token. Leave it empty to use light mode.
- `Model`: `vlm` or `pipeline`.
- `Language`: default is `ch`; use `en` for English.
- `Formula recognition`, `Table recognition`, and `Force OCR`: shared by Token,
  light, and local API modes.
- `Use local MinerU API`: when enabled, files are not uploaded to mineru.net.
- `API URL`: Router default is `http://127.0.0.1:8002`; direct API is commonly
  `http://127.0.0.1:8000`.
- `Router concurrency`: local Router concurrency. Default is `2`.
- `Default folder`: default output folder for attachment export.

## Project Structure

- `src/modules/pdfToMd.ts`: menus, queue, conversion flow, progress panel, and
  attachment export.
- `src/modules/renderHtml.ts`: basic rendering from Markdown / MinerU ZIP to
  HTML.
- `addon/content/preferences.xhtml`: Zotero preferences page.
- `addon/prefs.js`: default preference values.
- `addon/locale/*`: English and Chinese UI strings.

## Notes

- Plugin ID: `pdf-to-md@local`.
- Preference prefix: `extensions.zotero.pdftomd`.
- Current manifest supports Zotero `6.999` to `9.*`.
- The original `zotero-plugin-template` sample code has been removed.

## License

This project is licensed under the
[AGPL-3.0-or-later](./LICENSE) license.
