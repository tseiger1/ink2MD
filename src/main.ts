import { promises as fs } from 'fs';
import { Notice, Plugin, normalizePath, setIcon, setTooltip } from 'obsidian';
import { DEFAULT_SETTINGS, Ink2MDSettingTab } from './settings';
import type { Ink2MDSettings, ConvertedNote, NoteSource, ProcessedSourceInfo } from './types';
import { discoverNoteSources } from './importers';
import { convertSourceToPng } from './conversion';
import { LLMService } from './llm';
import { buildMarkdown } from './markdown/generator';
import { hashFile } from './utils/hash';

type SourceFingerprint = Omit<ProcessedSourceInfo, 'processedAt' | 'outputFolder'>;
interface FreshnessResult {
	shouldProcess: boolean;
	fingerprint?: SourceFingerprint;
	previousFolder?: string;
}

	export default class Ink2MDPlugin extends Plugin {
	settings: Ink2MDSettings;
	private statusBarEl: HTMLElement | null = null;
	private statusIconEl: HTMLElement | null = null;
	private isImporting = false;
	private cancelRequested = false;
	private abortController: AbortController | null = null;
	private pendingSpinnerStop = false;

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
			return;
		}

		new Notice('Ink2MD: scanning input directories...');
		this.setStatus('Scanning for handwritten notes...');
		const sources = await discoverNoteSources(this.settings);

		if (!sources.length) {
			new Notice('Ink2MD: no new handwritten files found.');
			finalStatus = 'No sources found';
			this.setStatus(finalStatus);
			return;
		}

      let llm: LLMService;
		try {
			llm = new LLMService(this.settings);
		} catch (error) {
			console.error(error);
			new Notice('Ink2MD: unable to initialize the selected LLM provider.');
			finalStatus = 'LLM initialization failed';
			this.setStatus(finalStatus);
			return;
		}

		let processed = 0;
		let cancelled = false;
		for (const source of sources) {
			if (this.cancelRequested) {
				cancelled = true;
				break;
			}

			const freshness = await this.evaluateSourceFreshness(source);
			if (!freshness.shouldProcess) {
				continue;
			}

			const reusePath = this.settings.replaceExisting ? freshness.previousFolder : undefined;

			this.setStatus(`Processing ${processed + 1}/${sources.length}: ${source.basename}`);
			const converted = await convertSourceToPng(source, {
				attachmentMaxWidth: this.settings.attachmentMaxWidth,
				pdfDpi: this.settings.pdfDpi,
			});
			if (!converted) {
				continue;
			}

			const folderPath = await this.ensureNoteFolder(converted.source.basename, reusePath);

			if (this.cancelRequested) {
				cancelled = true;
				break;
			}

		this.setStatus(`Reading handwriting ${processed + 1}/${sources.length}`);
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

		this.setStatus(`Writing note ${processed + 1}/${sources.length}`);
			await this.persistNote(converted, llmMarkdown, folderPath);
			await this.rememberProcessedSource(source, freshness.fingerprint, folderPath);
			processed += 1;
		}

		if (cancelled) {
			finalStatus = 'Cancelled';
			this.setStatus(finalStatus);
			new Notice('Ink2MD: import cancelled.');
		} else {
			new Notice(`Ink2MD: imported ${processed} note${processed === 1 ? '' : 's'}.`);
			finalStatus = 'Idle';
			this.setStatus(finalStatus);
		}
    } finally {
      this.finishImport(finalStatus);
    }
  }

	private async persistNote(note: ConvertedNote, llmMarkdown: string, targetFolder?: string) {
		const adapter = this.app.vault.adapter;
		const folderPath = targetFolder ?? (await this.ensureNoteFolder(note.source.basename));
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
		if (this.statusIconEl) {
			setTooltip(this.statusIconEl, message, {
				placement: 'top',
				delay: 0,
			});
		}
	}

	private setupStatusBar() {
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('ink2md-status');
		this.statusIconEl = this.statusBarEl.createSpan({ cls: 'ink2md-status-icon' });
		this.statusIconEl.addEventListener('animationiteration', () => {
			if (this.pendingSpinnerStop) {
				this.statusIconEl?.classList.remove('is-spinning');
				this.pendingSpinnerStop = false;
			}
		});
		this.statusIconEl.addEventListener('click', () => {
			if (this.isImporting) {
				if (this.cancelRequested) {
					return;
				}
				this.cancelRequested = true;
				this.abortController?.abort();
				this.setStatus('Cancelling...');
				new Notice('Ink2MD: cancelling current import...');
				return;
			}
			this.triggerImport().catch((error) => console.error(error));
		});
		this.setSpinner(false);
		this.setStatus('Idle');
	}

	private setSpinner(active: boolean) {
		const icon = this.statusIconEl;
		if (!icon) {
			return;
		}
		setIcon(icon, 'pen-tool');
		icon.classList.add('is-clickable');
		if (active) {
			this.pendingSpinnerStop = false;
			icon.classList.add('is-spinning');
			icon.style.animationPlayState = 'running';
		} else {
			if (icon.classList.contains('is-spinning')) {
				this.pendingSpinnerStop = true;
				icon.style.animationPlayState = 'running';
			} else {
				this.pendingSpinnerStop = false;
			}
		}
	}

	private finishImport(finalStatus: string) {
		this.setSpinner(false);
		this.isImporting = false;
		this.abortController = null;
		if (this.cancelRequested) {
			this.setStatus('Cancelled');
			this.cancelRequested = false;
			return;
		}
		this.setStatus(finalStatus);
	}

	private ensureProcessedStore() {
		if (!this.settings.processedSources) {
			this.settings.processedSources = {};
		}
		return this.settings.processedSources;
	}

	private async evaluateSourceFreshness(source: NoteSource): Promise<FreshnessResult> {
		const store = this.ensureProcessedStore();
		let stats;
		try {
			stats = await fs.stat(source.filePath);
		} catch (error) {
			console.warn(`[ink2md] Unable to stat ${source.filePath}`, error);
			return { shouldProcess: true };
		}

		const cached = store[source.id];
		const previousFolder = cached?.outputFolder;
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return { shouldProcess: false, previousFolder };
		}

		let hash: string;
		try {
			hash = await hashFile(source.filePath);
		} catch (error) {
			console.warn(`[ink2md] Unable to hash ${source.filePath}`, error);
			return { shouldProcess: true, previousFolder };
		}

		if (cached && cached.hash === hash) {
			store[source.id] = {
				...cached,
				hash,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			};
			await this.saveSettings();
			return { shouldProcess: false, previousFolder };
		}

		return {
			shouldProcess: true,
			fingerprint: {
				hash,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			},
			previousFolder,
		};
	}

	private async rememberProcessedSource(source: NoteSource, fingerprint?: SourceFingerprint, folderPath?: string) {
		const store = this.ensureProcessedStore();
		const finalFingerprint = fingerprint ?? (await this.computeFingerprint(source));
		if (!finalFingerprint) {
			return;
		}
		const previous = store[source.id];
		const outputFolder = folderPath ?? previous?.outputFolder ?? '';
		store[source.id] = {
			...finalFingerprint,
			processedAt: new Date().toISOString(),
			outputFolder,
		};
		await this.saveSettings();
	}

	private async computeFingerprint(source: NoteSource): Promise<SourceFingerprint | null> {
		let stats;
		try {
			stats = await fs.stat(source.filePath);
		} catch (error) {
			console.warn(`[ink2md] Unable to stat ${source.filePath} for fingerprint`, error);
			return null;
		}
		try {
			const hash = await hashFile(source.filePath);
			return {
				hash,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			};
		} catch (error) {
			console.warn(`[ink2md] Unable to hash ${source.filePath}`, error);
			return null;
		}
	}

	private async resetFolder(folderPath: string) {
		const adapter = this.app.vault.adapter as unknown as { rmdir?: (path: string, recursive?: boolean) => Promise<void> };
		if (await this.app.vault.adapter.exists(folderPath)) {
			if (typeof adapter.rmdir === 'function') {
				try {
					await adapter.rmdir(folderPath, true);
				} catch (error) {
					console.warn(`[ink2md] Unable to remove folder ${folderPath}`, error);
				}
			} else {
				const listing = await this.app.vault.adapter.list(folderPath);
				for (const file of listing.files) {
					await this.app.vault.adapter.remove(file);
				}
				for (const folder of listing.folders) {
					await this.resetFolder(folder);
				}
				try {
					await this.app.vault.adapter.remove(folderPath);
				} catch (error) {
					console.warn(`[ink2md] Unable to remove folder ${folderPath}`, error);
				}
			}
		}
		await this.app.vault.adapter.mkdir(folderPath);
	}

	private async ensureNoteFolder(baseName: string, reusePath?: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const root = normalizePath(this.settings.outputFolder || 'Ink2MD');
		if (!(await adapter.exists(root))) {
			await adapter.mkdir(root);
		}

		if (reusePath) {
			const normalizedReuse = normalizePath(reusePath);
			if (await adapter.exists(normalizedReuse)) {
				if (this.settings.replaceExisting) {
					await this.resetFolder(normalizedReuse);
				}
				return normalizedReuse;
			}
		}

		let candidate = normalizePath(`${root}/${baseName}`);
		let counter = 1;
		while (await adapter.exists(candidate)) {
			if (this.settings.replaceExisting) {
				await this.resetFolder(candidate);
				return candidate;
			}
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
		const processedSources = { ...(stored?.processedSources ?? DEFAULT_SETTINGS.processedSources) };
		const replaceExisting = stored?.replaceExisting ?? DEFAULT_SETTINGS.replaceExisting;
		this.settings = {
		  ...DEFAULT_SETTINGS,
		  ...(stored ?? {}),
		  attachmentMaxWidth,
		  llmMaxWidth,
		  pdfDpi,
		  replaceExisting,
		  openAI: {
		    ...DEFAULT_SETTINGS.openAI,
		    ...(stored?.openAI ?? {}),
		    imageDetail: stored?.openAI?.imageDetail ?? DEFAULT_SETTINGS.openAI.imageDetail,
		  },
		  local: {
		    ...DEFAULT_SETTINGS.local,
		    ...(stored?.local ?? {}),
		    imageDetail: stored?.local?.imageDetail ?? DEFAULT_SETTINGS.local.imageDetail,
		  },
		  processedSources,
		} as Ink2MDSettings;
	}

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
