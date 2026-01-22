import { Notice, Plugin, normalizePath, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, Ink2MDSettingTab } from './settings';
import type { Ink2MDSettings, ConvertedNote } from './types';
import { discoverNoteSources } from './importers';
import { convertSourceToPng } from './conversion';
import { LLMService } from './llm';
import { buildMarkdown } from './markdown/generator';

export default class Ink2MDPlugin extends Plugin {
  settings: Ink2MDSettings;
  private statusBarEl: HTMLElement | null = null;
  private statusIconEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private isImporting = false;
  private cancelRequested = false;
  private abortController: AbortController | null = null;

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

    this.setupStatusBar();

    this.addSettingTab(new Ink2MDSettingTab(this.app, this));
  }

  async triggerImport() {
    if (this.isImporting) {
      new Notice('Ink2MD: an import is already running. Click the spinner to cancel.');
      return;
    }

		this.isImporting = true;
		this.cancelRequested = false;
		this.abortController = new AbortController();
		this.setSpinner(true);

    let finalStatus = 'Idle';
    try {
		if (!this.settings.inputDirectories.length) {
			new Notice('Ink2MD: configure at least one input directory.');
			finalStatus = 'Configuration required';
			this.setStatus(finalStatus);
			this.statusIconEl?.setAttr('aria-label', 'Ink2MD: configure input directories');
			return;
		}

		new Notice('Ink2MD: scanning input directories...');
		this.setStatus('Scanning for handwritten notes...');
		this.statusIconEl?.setAttr('aria-label', 'Ink2MD: scanning inputs');
		const sources = await discoverNoteSources(this.settings);

      if (!sources.length) {
      new Notice('Ink2MD: no new handwritten files found.');
      this.statusIconEl?.setAttr('aria-label', 'Ink2MD: no sources found');
      finalStatus = 'No sources found';
      return;
    }

      let llm: LLMService;
      try {
        llm = new LLMService(this.settings);
      } catch (error) {
        console.error(error);
        new Notice('Ink2MD: unable to initialize the selected LLM provider.');
        finalStatus = 'LLM initialization failed';
        this.statusIconEl?.setAttr('aria-label', 'Ink2MD: LLM initialization failed');
        return;
      }

      let processed = 0;
      let cancelled = false;
      for (const source of sources) {
        if (this.cancelRequested) {
          cancelled = true;
          break;
        }

        this.setStatus(`Processing ${processed + 1}/${sources.length}: ${source.basename}`);
        this.statusIconEl?.setAttr('aria-label', `Ink2MD: processing ${processed + 1}/${sources.length} - ${source.basename}`);
        const converted = await convertSourceToPng(source, {
          attachmentMaxWidth: this.settings.attachmentMaxWidth,
          pdfDpi: this.settings.pdfDpi,
        });
        if (!converted) {
          continue;
        }

        if (this.cancelRequested) {
          cancelled = true;
          break;
        }

		this.statusIconEl?.setAttr('aria-label', `Ink2MD: generating summary ${processed + 1}/${sources.length}`);
		let llmMarkdown = '';
		try {
			llmMarkdown = await llm.generateMarkdown(converted, this.abortController?.signal);
		} catch (error) {
			if (this.cancelRequested && this.abortController?.signal?.aborted) {
				cancelled = true;
				break;
			}
			console.error('[ink2md] Failed to generate markdown', error);
			llmMarkdown = '_LLM generation failed._';
		}

        if (this.cancelRequested) {
          cancelled = true;
          break;
        }

        this.statusIconEl?.setAttr('aria-label', `Ink2MD: writing note ${processed + 1}/${sources.length}`);
        await this.persistNote(converted, llmMarkdown);
        processed += 1;
      }

      if (cancelled) {
        finalStatus = 'Cancelled';
        this.statusIconEl?.setAttr('aria-label', 'Ink2MD: import cancelled');
        new Notice('Ink2MD: import cancelled.');
      } else {
        new Notice(`Ink2MD: imported ${processed} note${processed === 1 ? '' : 's'}.`);
        finalStatus = 'Idle';
        this.statusIconEl?.setAttr('aria-label', 'Ink2MD: idle');
      }
    } finally {
      this.finishImport(finalStatus);
    }
  }

  private async persistNote(note: ConvertedNote, llmMarkdown: string) {
    const adapter = this.app.vault.adapter;
    const folderPath = await this.ensureNoteFolder(note.source.basename);
    const imageEmbeds: Array<{ path: string; width: number }> = [];

    for (const page of note.pages) {
      const imagePath = normalizePath(`${folderPath}/${page.fileName}`);
      imageEmbeds.push({ path: `./${page.fileName}`, width: page.width });
      await adapter.writeBinary(imagePath, bufferToArrayBuffer(page.data));
    }

    const markdownPath = normalizePath(`${folderPath}/${note.source.basename}.md`);
    const markdown = buildMarkdown({
      note,
      llmMarkdown,
      imageEmbeds,
    });

    if (await adapter.exists(markdownPath)) {
      await adapter.remove(markdownPath);
    }

    await adapter.write(markdownPath, markdown);
  }

  private setStatus(message: string) {
    this.statusTextEl?.setText('');
  }

  private setupStatusBar() {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('ink2md-status');
    this.statusIconEl = this.statusBarEl.createSpan({ cls: 'ink2md-status-icon' });
    this.statusIconEl.addEventListener('click', () => {
      if (this.isImporting) {
        if (this.cancelRequested) {
          return;
        }
        this.cancelRequested = true;
        this.abortController?.abort();
        this.statusIconEl?.setAttr('aria-label', 'Ink2MD: cancelling...');
        new Notice('Ink2MD: cancelling current import...');
        return;
      }
      this.triggerImport().catch((error) => console.error(error));
    });
    this.setSpinner(false);
    this.setStatus('Idle');
  }

	private setSpinner(active: boolean) {
		if (!this.statusIconEl) {
			return;
		}
		setIcon(this.statusIconEl, active ? 'loader' : 'pen-tool');
		this.statusIconEl.toggleClass('is-spinning', active);
		this.statusIconEl.toggleClass('is-clickable', active);
		if (!active) {
			this.statusIconEl.setAttr('aria-label', 'Ink2MD: idle');
		}
	}

	private finishImport(finalStatus: string) {
		this.setSpinner(false);
		this.isImporting = false;
		this.abortController = null;
		if (this.cancelRequested) {
			this.setStatus('Cancelled');
			this.statusIconEl?.setAttr('aria-label', 'Ink2MD: cancelled');
			this.cancelRequested = false;
			return;
		}
		this.setStatus(finalStatus);
		this.statusIconEl?.setAttr('aria-label', `Ink2MD: ${finalStatus.toLowerCase()}`);
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
    const stored = (await this.loadData()) as (Partial<Ink2MDSettings> & { maxImageWidth?: number }) | null;
    const attachmentMaxWidth = stored?.attachmentMaxWidth ?? stored?.maxImageWidth ?? DEFAULT_SETTINGS.attachmentMaxWidth;
    const llmMaxWidth = stored?.llmMaxWidth ?? attachmentMaxWidth ?? DEFAULT_SETTINGS.llmMaxWidth;
    const pdfDpi = stored?.pdfDpi ?? DEFAULT_SETTINGS.pdfDpi;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      attachmentMaxWidth,
      llmMaxWidth,
      pdfDpi,
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
