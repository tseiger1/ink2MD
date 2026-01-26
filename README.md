# Ink2MD

Ink2MD is an Obsidian plugin that brings handwritten notebooks into your vault. It scans configurable folders, turns the discovered pages into PNG files, and asks a vision LLM (OpenAI or a local llama-style endpoint) to create Markdown notes for every import.

## Features
- Watch multiple input directories (with recursive scanning) for handwritten notes.
- Convert JPG/PNG/WebP images and PDFs into PNG pages with an optional width cap.
- Generate Markdown summaries through OpenAI, Google Gemini, or any OpenAI-compatible local endpoint.
- Store all generated pages and Markdown files inside a dedicated folder in your vault.

## Setup
1. Install dependencies in this repo once with `npm install` (Node 18+ recommended).
2. Copy the plugin folder to `<vault>/.obsidian/plugins/ink2md/`.
3. Run `npm run dev` while developing, or `npm run build` to produce the release bundle (`main.js`).
4. In Obsidian, enable **Ink2MD** under **Settings → Community plugins**.

## Configuration
Open **Settings → Community plugins → Ink2MD** and adjust:
- **Sources**: each source points at one or more absolute directories, controls which import types (images, PDFs) run, holds conversion options (PNG width, PDF DPI, overwrite policy), and decides whether generated notes open automatically. Every source links to exactly one LLM preset.
- **LLM presets**: reusable provider profiles containing OpenAI, Google Gemini, or local endpoint details along with prompt templates, image detail, model name, image-width limits, and whether generation streams live or waits for the full response. Ollama works well out of the box when exposing its OpenAI-compatible server with the `mistral-small:3.1` model.
- **Processed files cache**: clear it globally from the Sources section or per source if you need to force a re-import.

## Usage
1. Add one or more sources that point at the folders containing your handwritten exports.
2. Use the ribbon icon or run the `Ink2MD: Import handwritten notes` command.
3. Wait for notices indicating scanning, conversion, and generation progress.
4. Inspect the output folder in your vault—each imported note has its own sub-folder containing the generated PNG pages and Markdown file.

## Notes & limitations
- PDF conversion relies on `pdfjs-dist` rendered inside a hidden DOM canvas. Large notebooks can take a few seconds per page.
- `src/pdfWorkerSource.ts` embeds the upstream worker script; regenerate it after upgrading `pdfjs-dist`.
- OpenAI calls require an active internet connection. Local providers must accept OpenAI-compatible payloads with `image_url` entries that contain `data:` URLs.
- The plugin targets desktop Obsidian because it accesses the local file system.
- Already-processed files are skipped automatically by comparing file hashes and timestamps, so only new or modified exports are converted.
