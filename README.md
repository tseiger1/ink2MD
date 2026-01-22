# Ink2MD

Ink2MD is an Obsidian plugin that brings handwritten notebooks into your vault. It scans configurable folders, turns the discovered pages into PNG files, and asks a vision LLM (OpenAI or a local llama-style endpoint) to create Markdown notes for every import.

## Features
- Watch multiple input directories (with recursive scanning) for handwritten notes.
- Convert JPG/PNG/WebP images, PDFs, and Supernote `.note` notebooks into PNG pages with an optional width cap.
- Stub module for e-ink formats: detected files are reported but skipped until a converter is provided.
- Generate Markdown summaries through OpenAI or any OpenAI-compatible local endpoint.
- Store all generated pages and Markdown files inside a dedicated folder in your vault.

## Setup
1. Install dependencies in this repo once with `npm install` (Node 18+ recommended).
2. Copy the plugin folder to `<vault>/.obsidian/plugins/ink2md/`.
3. Run `npm run dev` while developing, or `npm run build` to produce the release bundle (`main.js`).
4. In Obsidian, enable **Ink2MD** under **Settings → Community plugins**.

## Configuration
Open **Settings → Community plugins → Ink2MD** and adjust:
- Input directories: absolute OS paths; sub-folders are scanned automatically.
- Output folder: vault-relative folder where PNG files and Markdown live.
- Formats: toggle image, PDF, and e-ink discovery modules.
- Conversion: pick separate PNG width caps for files stored in the vault and for the LLM payloads (set a slider to 0 to keep originals) plus a dedicated DPI value for PDF rasterization.
- Replacement: enable “Replace existing notes” to overwrite previous imports instead of creating timestamped folders, and reset the processed-file cache when you want to force a re-import.
- LLM provider:
  - **OpenAI**: add your API key, preferred vision-capable model, and prompt template.
  - **Local**: specify the endpoint URL (must speak the OpenAI Chat Completions protocol), optional API key, model name, and prompt.

## Usage
1. Populate the input directory list with folders that contain your handwritten exports.
2. Use the ribbon icon or run the `Ink2MD: Import handwritten notes` command.
3. Wait for notices indicating scanning, conversion, and generation progress.
4. Inspect the output folder in your vault—each imported note has its own sub-folder containing the generated PNG pages and Markdown file.

## Notes & limitations
- PDF conversion relies on `pdfjs-dist` rendered inside a hidden DOM canvas. Large notebooks can take a few seconds per page.
- `src/pdfWorkerSource.ts` embeds the upstream worker script; regenerate it after upgrading `pdfjs-dist`.
- The e-ink module is a stub; files are detected but skipped until a proper decoder lands.
- OpenAI calls require an active internet connection. Local providers must accept OpenAI-compatible payloads with `image_url` entries that contain `data:` URLs.
- The plugin targets desktop Obsidian because it accesses the local file system.
- Already-processed files are skipped automatically by comparing file hashes and timestamps, so only new or modified exports are converted.
