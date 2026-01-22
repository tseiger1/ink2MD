import { Notice, Plugin, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, Ink2MDSettingTab } from './settings';
import type { Ink2MDSettings, ConvertedNote } from './types';
import { discoverNoteSources } from './importers';
import { convertSourceToPng } from './conversion';
import { LLMService } from './llm';
import { buildMarkdown } from './markdown/generator';

export default class Ink2MDPlugin extends Plugin {
  settings: Ink2MDSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('pen-tool', 'Import handwritten notes', () => {
      this.triggerImport().catch((error) => console.error(error));
    });

    this.addCommand({
      id: 'ink2md-import',
      name: 'Import handwritten notes',
      callback: () => this.triggerImport(),
    });

    this.addSettingTab(new Ink2MDSettingTab(this.app, this));
  }

  async triggerImport() {
    if (!this.settings.inputDirectories.length) {
      new Notice('Ink2MD: configure at least one input directory.');
      return;
    }

    new Notice('Ink2MD: scanning input directories...');
    const sources = await discoverNoteSources(this.settings);

    if (!sources.length) {
      new Notice('Ink2MD: no new handwritten files found.');
      return;
    }

    let llm: LLMService;
    try {
      llm = new LLMService(this.settings);
    } catch (error) {
      console.error(error);
      new Notice('Ink2MD: unable to initialize the selected LLM provider.');
      return;
    }

    let processed = 0;
    for (const source of sources) {
      const converted = await convertSourceToPng(source, this.settings.maxImageWidth);
      if (!converted) {
        continue;
      }

      let llmMarkdown = '';
      try {
        llmMarkdown = await llm.generateMarkdown(converted);
      } catch (error) {
        console.error('[ink2md] Failed to generate markdown', error);
        llmMarkdown = '_LLM generation failed._';
      }

      await this.persistNote(converted, llmMarkdown);
      processed += 1;
    }

    new Notice(`Ink2MD: imported ${processed} note${processed === 1 ? '' : 's'}.`);
  }

  private async persistNote(note: ConvertedNote, llmMarkdown: string) {
    const adapter = this.app.vault.adapter;
    const folderPath = await this.ensureNoteFolder(note.source.basename);
    const relativeImages: string[] = [];

    for (const page of note.pages) {
      const imagePath = normalizePath(`${folderPath}/${page.fileName}`);
      relativeImages.push(`./${page.fileName}`);
      await adapter.writeBinary(imagePath, bufferToArrayBuffer(page.data));
    }

    const markdownPath = normalizePath(`${folderPath}/${note.source.basename}.md`);
    const markdown = buildMarkdown({
      note,
      llmMarkdown,
      imagePaths: relativeImages,
    });

    if (await adapter.exists(markdownPath)) {
      await adapter.remove(markdownPath);
    }

    await adapter.write(markdownPath, markdown);
  }

  private async ensureNoteFolder(baseName: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const root = normalizePath(this.settings.outputFolder || 'Ink2MD');
    if (!(await adapter.exists(root))) {
      await adapter.mkdir(root);
    }

    let candidate = normalizePath(`${root}/${baseName}`);
    let counter = 1;
    while (await adapter.exists(candidate)) {
      counter += 1;
      candidate = normalizePath(`${root}/${baseName}-${counter}`);
    }

    await adapter.mkdir(candidate);
    return candidate;
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<Ink2MDSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      openAI: {
        ...DEFAULT_SETTINGS.openAI,
        ...(stored?.openAI ?? {}),
      },
      local: {
        ...DEFAULT_SETTINGS.local,
        ...(stored?.local ?? {}),
      },
    } as Ink2MDSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
