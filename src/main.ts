import { Buffer } from 'buffer';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FileSystemAdapter, Notice, Plugin, TFile, normalizePath, setIcon, setTooltip } from 'obsidian';
import type { SecretStorage } from 'obsidian';
import { DEFAULT_SETTINGS, Ink2MDSettingTab } from './settings';
import type {
	Ink2MDSettings,
	ConvertedNote,
	NoteSource,
	ProcessedSourceInfo,
	ImageEmbed,
	SourceConfig,
	LLMPreset,
	InputFormat,
} from './types';
import { discoverNoteSourcesForConfig } from './importers';
import { convertSourceToPng } from './conversion';
import { LLMService } from './llm';
import { buildMarkdown, buildFrontMatter, buildPagesSection } from './markdown/generator';
import { hashFile } from './utils/hash';
import { createStableId, slugifyFilePath } from './utils/naming';
import { isImageFile } from './importers/imageImporter';
import { isPdfFile } from './importers/pdfImporter';
import { Ink2MDDropView, VIEW_TYPE_INK2MD_DROP } from './ui/dropView';

type SecretProvider = 'openai' | 'azure-openai' | 'gemini';

const OPENAI_SECRET_ID = 'ink2md-openai-api-key';
const AZURE_OPENAI_SECRET_ID = 'ink2md-azure-openai-api-key';
const GEMINI_SECRET_ID = 'ink2md-gemini-api-key';
const SECRET_SUFFIX_LENGTH = 10;
const PROVIDER_SECRET_PREFIX: Record<SecretProvider, string> = {
	openai: `${OPENAI_SECRET_ID}-`,
	'azure-openai': `${AZURE_OPENAI_SECRET_ID}-`,
	gemini: `${GEMINI_SECRET_ID}-`,
};

type SourceFingerprint = {
	hash: string;
	size: number;
	mtimeMs: number;
};

type StoredSettingsSnapshot = Partial<
	Omit<Ink2MDSettings, 'processedSources' | 'secretBindings'>
> & {
	processedSources?: Record<string, unknown>;
	secretBindings?: Record<string, unknown>;
	[key: string]: unknown;
};

type LegacySettingsSnapshot = StoredSettingsSnapshot & {
	llmProvider?: LLMPreset['provider'];
	llmGenerationMode?: LLMPreset['generationMode'];
	llmMaxWidth?: number;
	openAI?: Partial<LLMPreset['openAI']>;
	azureOpenAI?: Partial<LLMPreset['azureOpenAI']>;
	local?: Partial<LLMPreset['local']>;
	gemini?: Partial<LLMPreset['gemini']>;
	inputDirectories?: unknown;
	includeImages?: boolean;
	includePdfs?: boolean;
	attachmentMaxWidth?: number;
	maxImageWidth?: number;
	pdfDpi?: number;
	replaceExisting?: boolean;
	outputFolder?: string;
	openGeneratedNotes?: boolean;
	processedSources?: Record<string, unknown>;
	preImportScript?: string;
};

function isProcessedSourceInfo(value: unknown): value is ProcessedSourceInfo {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.hash === 'string' &&
		typeof candidate.size === 'number' &&
		typeof candidate.mtimeMs === 'number' &&
		typeof candidate.processedAt === 'string' &&
		typeof candidate.outputFolder === 'string' &&
		typeof candidate.sourceId === 'string'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isStoredSettingsSnapshot(value: unknown): value is StoredSettingsSnapshot {
	return isRecord(value);
}
interface FreshnessResult {
	shouldProcess: boolean;
	fingerprint?: SourceFingerprint;
	previousFolder?: string;
}

interface ImportJob {
	note: NoteSource;
	sourceConfig: SourceConfig;
	preset: LLMPreset;
}

interface ImportRunOptions {
	preparingNotice?: string;
	preparingStatus?: string;
}

	export default class Ink2MDPlugin extends Plugin {
	settings: Ink2MDSettings;
	private statusBarEl: HTMLElement | null = null;
	private statusIconEl: HTMLElement | null = null;
	private isImporting = false;
	private cancelRequested = false;
	private abortController: AbortController | null = null;
	private pendingSpinnerStop = false;
	private openAISecrets: Record<string, string | null> = {};
	private azureOpenAISecrets: Record<string, string | null> = {};
	private geminiSecrets: Record<string, string | null> = {};
	private notifiedMissingSecretStorage = false;
	private stagedFiles = new Set<string>();
	private dropzoneCacheDir: string | null = null;

	getPluginName(): string {
		return this.manifest?.name ?? 'Ink2MD';
	}

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_INK2MD_DROP, (leaf) => new Ink2MDDropView(leaf, this));
    this.app.workspace.onLayoutReady(() => {
      this.activateDropzoneView(false).catch((error) => console.error(error));
    });

    this.addRibbonIcon('pen-tool', 'Import handwritten notes', () => {
      this.triggerImport().catch((error) => console.error(error));
    });

    this.addCommand({
      id: 'import-handwritten-notes',
      name: 'Import handwritten notes',
      callback: () => this.triggerImport(),
    });

    this.addCommand({
      id: 'open-dropzone-view',
      name: 'Open dropzone view',
      callback: () => this.activateDropzoneView(true),
    });

    this.setupStatusBar();

    this.addSettingTab(new Ink2MDSettingTab(this.app, this));
  }

  onunload(): void {
    void this.handleUnload();
  }

  private async handleUnload(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INK2MD_DROP);
    if (leaves.length) {
      const fallback = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ?? this.app.workspace.getLeaf(false);
      if (fallback) {
        this.app.workspace.setActiveLeaf(fallback, { focus: false });
      }
      for (const leaf of leaves) {
        try {
          leaf.detach();
        } catch (error) {
          console.warn('[ink2md] Unable to detach dropzone leaf on unload.', error);
        }
      }
    }
    await this.cleanupStagedFiles(Array.from(this.stagedFiles));
  }

	async triggerImport() {
		await this.withImportLock(async () => {
		const { jobs, blockedByScript } = await this.collectImportJobs();
		if (!jobs.length) {
			if (blockedByScript) {
				this.setStatus('Script blocked import');
				return 'Script blocked';
			}
					new Notice('No sources are ready to import. Configure at least one source with directories and a language model preset.');
				this.setStatus('Configuration required');
			return 'Configuration required';
		}
			return this.processImportJobs(jobs, {
				preparingNotice: 'Ink2MD: scanning input directories...',
				preparingStatus: 'Scanning for handwritten notes...',
			});
		});
	}

	async importDroppedFiles(sourceId: string, filePaths: string[]) {
		const normalizedPaths = Array.from(
			new Set(
				filePaths
					.map((filePath) => (typeof filePath === 'string' ? filePath.trim() : ''))
					.filter((entry) => entry.length > 0),
				),
		);
			if (!normalizedPaths.length) {
				new Notice('No files selected for import.');
			return;
		}
		const sourceConfig = this.settings.sources.find((source) => source.id === sourceId && source.type === 'dropzone');
			if (!sourceConfig) {
				new Notice('Configure a dropzone source in settings before importing.');
			return;
		}
		const preset = this.resolvePresetForSource(sourceConfig);
		if (!preset) {
			return;
		}
		const scriptReady = await this.runPreImportScriptForSource(sourceConfig);
		if (!scriptReady) {
			return;
		}
		const notes: NoteSource[] = [];
		for (const filePath of normalizedPaths) {
			const format = this.detectFormatForPath(filePath);
			if (!format) {
				console.warn(`[ink2md] Unsupported file dropped: ${filePath}`);
				continue;
			}
			if (!this.isFormatEnabled(format, sourceConfig)) {
				console.warn(`[ink2md] ${format} imports disabled for ${sourceConfig.label}. Skipping ${filePath}`);
				continue;
			}
			notes.push(this.createManualNoteSource(filePath, format, sourceConfig));
		}
			if (!notes.length) {
				new Notice('None of the selected files match this source configuration.');
			return;
		}
		const jobs = notes.map((note) => ({ note, sourceConfig, preset }));
			await this.withImportLock(() =>
				this.processImportJobs(jobs, {
					preparingNotice: 'Ink2MD: preparing dropped files...',
					preparingStatus: 'Preparing dropped files...',
				}),
			);
	}

	private async withImportLock(task: () => Promise<string>): Promise<void> {
			if (this.isImporting) {
				new Notice('An import is already running. Click the spinner to cancel.');
			return;
		}
		this.isImporting = true;
		this.cancelRequested = false;
		this.abortController = new AbortController();
		this.setSpinner(true);
		let finalStatus = 'Idle';
		try {
			finalStatus = await task();
			} catch (error) {
				console.error('[ink2md] Import run failed', error);
				new Notice('Import failed. Check developer console for details.');
			finalStatus = 'Idle';
		} finally {
			this.finishImport(finalStatus);
		}
	}

	private async collectImportJobs(): Promise<{ jobs: ImportJob[]; blockedByScript: boolean }> {
		const jobs: ImportJob[] = [];
		let blockedByScript = false;
		const sources = this.settings.sources ?? [];
		if (!sources.length) {
			return { jobs, blockedByScript };
		}

		for (const sourceConfig of sources) {
			if (sourceConfig.type !== 'filesystem') {
				continue;
			}
			if (!sourceConfig.directories.length) {
				new Notice(`Source "${sourceConfig.label}" has no directories configured.`);
				continue;
			}
			const preset = this.resolvePresetForSource(sourceConfig);
			if (!preset) {
				continue;
			}
			const scriptReady = await this.runPreImportScriptForSource(sourceConfig);
			if (!scriptReady) {
				blockedByScript = true;
				continue;
			}
			const notes = await discoverNoteSourcesForConfig(sourceConfig);
			for (const note of notes) {
				jobs.push({ note, sourceConfig, preset });
			}
		}

		return { jobs, blockedByScript };
	}

	private async runPreImportScriptForSource(sourceConfig: SourceConfig): Promise<boolean> {
		const command = sourceConfig.preImportScript?.trim();
		if (!command) {
			return true;
		}
		this.setStatus(`Running script: ${sourceConfig.label}`);
			return await new Promise((resolve) => {
				const cwd = this.getVaultBasePath() ?? undefined;
				const child = spawn(command, {
					shell: true,
					cwd,
				});
				let stdout = '';
				let stderr = '';
				child.stdout?.on('data', (data: Buffer) => {
					stdout += data.toString();
				});
				child.stderr?.on('data', (data: Buffer) => {
					stderr += data.toString();
				});
			child.on('error', (error) => {
				console.error(`[ink2md] Failed to start pre-import script for ${sourceConfig.label}`, error);
					new Notice(`Pre-import script for "${sourceConfig.label}" failed to start (${error.message}).`);
				resolve(false);
			});
				child.on('close', (code, signal) => {
				if (code === 0) {
						let successMessage = stdout.trim();
						if (!successMessage) {
							successMessage = 'Script finished successfully';
						}
						if (successMessage.length > 280) {
							successMessage = `${successMessage.slice(0, 277)}...`;
						}
							new Notice(`Script for "${sourceConfig.label}" succeeded (${successMessage}).`);
						resolve(true);
						return;
					}
					let message = stderr.trim() || stdout.trim();
					if (!message) {
						if (signal) {
							message = `terminated (${signal})`;
						} else {
							message = `exit code ${code ?? 'unknown'}`;
						}
					}
					if (message.length > 280) {
						message = `${message.slice(0, 277)}...`;
					}
							new Notice(`Pre-import script for "${sourceConfig.label}" failed (${message}).`);
					console.error(`[ink2md] Pre-import script for ${sourceConfig.label} failed: ${message}`);
					resolve(false);
				});
		});
	}

	private resolvePresetForSource(sourceConfig: SourceConfig): LLMPreset | null {
		if (!sourceConfig.llmPresetId) {
			new Notice(`Source "${sourceConfig.label}" is missing an LLM preset.`);
			return null;
		}
		const preset = this.getRuntimePreset(sourceConfig.llmPresetId);
			if (!preset) {
				new Notice(`Preset linked to "${sourceConfig.label}" was not found.`);
			return null;
		}
			if (preset.provider === 'openai' && !preset.openAI.apiKey) {
				new Notice(`Preset "${preset.label}" requires an OpenAI API key.`);
			return null;
		}
		if (preset.provider === 'azure-openai') {
				if (!preset.azureOpenAI.apiKey) {
					new Notice(`Preset "${preset.label}" requires an Azure OpenAI API key.`);
				return null;
			}
				if (!preset.azureOpenAI.endpoint || !preset.azureOpenAI.deployment) {
					new Notice(`Preset "${preset.label}" is missing the Azure endpoint or model name.`);
				return null;
			}
		}
			if (preset.provider === 'gemini' && !preset.gemini.apiKey) {
				new Notice(`Preset "${preset.label}" requires a Gemini API key.`);
			return null;
		}
		return preset;
	}

	private async processImportJobs(jobs: ImportJob[], options?: ImportRunOptions): Promise<string> {
		if (!jobs.length) {
			return 'Idle';
		}
		if (options?.preparingNotice) {
			new Notice(options.preparingNotice);
		}
		if (options?.preparingStatus) {
			this.setStatus(options.preparingStatus);
		}
		const llmCache = new Map<string, LLMService>();
		let processed = 0;
		let cancelled = false;
		for (const job of jobs) {
			const source = job.note;
			const preset = job.preset;
			const sourceConfig = job.sourceConfig;
			if (this.cancelRequested) {
				cancelled = true;
				break;
			}

			const freshness = await this.evaluateSourceFreshness(source);
			if (!freshness.shouldProcess) {
				continue;
			}

			const reusePath = sourceConfig.replaceExisting ? freshness.previousFolder : undefined;

			this.setStatus(`Processing ${processed + 1}/${jobs.length}: ${source.basename}`);
			const converted = await convertSourceToPng(source, {
				attachmentMaxWidth: sourceConfig.attachmentMaxWidth,
				pdfDpi: sourceConfig.pdfDpi,
			});
			if (!converted) {
				continue;
			}

			const folderPath = await this.ensureNoteFolder(converted.source, sourceConfig, reusePath);

			if (this.cancelRequested) {
				cancelled = true;
				break;
			}

			const llm = this.getOrCreateLLMService(preset, llmCache);
			const shouldStream = preset.generationMode === 'stream';
			this.setStatus(`Reading handwriting ${processed + 1}/${jobs.length}`);
			let streamFailed = false;
			if (shouldStream) {
				try {
					await this.streamMarkdownContent(converted, folderPath, sourceConfig, llm, this.abortController?.signal);
				} catch (error) {
					if (this.cancelRequested && this.abortController?.signal?.aborted) {
						cancelled = true;
						break;
					}
					console.error('[ink2md] Failed to stream markdown', error);
					streamFailed = true;
				}
			} else {
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

				this.setStatus(`Writing note ${processed + 1}/${jobs.length}`);
				await this.persistNote(converted, llmMarkdown, sourceConfig, folderPath);
				await this.rememberProcessedSource(source, freshness.fingerprint, folderPath, sourceConfig);
				processed += 1;
				continue;
			}

			if (this.cancelRequested) {
				cancelled = true;
				break;
			}

			this.setStatus(`Writing note ${processed + 1}/${jobs.length}`);
			const imageEmbeds = await this.writeAttachments(converted, folderPath);
			if (streamFailed) {
				await this.writeMarkdownFile(converted, folderPath, sourceConfig, '_LLM generation failed._', imageEmbeds);
			} else {
				await this.appendPagesSection(converted, folderPath, sourceConfig, imageEmbeds);
			}
			await this.rememberProcessedSource(source, freshness.fingerprint, folderPath, sourceConfig);
			processed += 1;
		}

		if (cancelled) {
			this.setStatus('Cancelled');
				new Notice('Import cancelled.');
			return 'Cancelled';
		}
				new Notice(`Imported ${processed} note${processed === 1 ? '' : 's'}.`);
		this.setStatus('Idle');
		return 'Idle';
	}

	private detectFormatForPath(filePath: string): InputFormat | null {
		if (isPdfFile(filePath)) {
			return 'pdf';
		}
		if (isImageFile(filePath)) {
			return 'image';
		}
		const ext = path.extname(filePath).toLowerCase();
		if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
			return 'image';
		}
		return null;
	}

	private isFormatEnabled(format: InputFormat, sourceConfig: SourceConfig): boolean {
		if (format === 'image') {
			return sourceConfig.includeImages;
		}
		if (format === 'pdf') {
			return sourceConfig.includePdfs;
		}
		return false;
	}

	private createManualNoteSource(filePath: string, format: InputFormat, sourceConfig: SourceConfig): NoteSource {
		return {
			id: createStableId(filePath, sourceConfig.id),
			sourceId: sourceConfig.id,
			format,
			filePath,
			basename: slugifyFilePath(filePath),
			inputRoot: path.dirname(filePath),
			relativeFolder: '',
		};
	}

	private getOrCreateLLMService(preset: LLMPreset, cache: Map<string, LLMService>): LLMService {
		let service = cache.get(preset.id);
		if (!service) {
			service = new LLMService(preset);
			cache.set(preset.id, service);
		}
		return service;
	}

	private getRuntimePreset(presetId: string): LLMPreset | null {
		const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
		if (!preset) {
			return null;
		}
		const resolvedOpenAIKey = this.getOpenAISecret(preset.id) || preset.openAI.apiKey;
		const resolvedAzureKey = this.getAzureOpenAISecret(preset.id) || preset.azureOpenAI.apiKey;
		const resolvedGeminiKey = this.getGeminiSecret(preset.id) || preset.gemini.apiKey;
		return {
			...preset,
			openAI: {
				...preset.openAI,
				apiKey: resolvedOpenAIKey ?? '',
			},
			azureOpenAI: {
				...preset.azureOpenAI,
				apiKey: resolvedAzureKey ?? '',
			},
			local: {
				...preset.local,
			},
			gemini: {
				...preset.gemini,
				apiKey: resolvedGeminiKey ?? '',
			},
		};
	}

	private async persistNote(
		note: ConvertedNote,
		llmMarkdown: string,
		sourceConfig: SourceConfig,
		targetFolder?: string,
	) {
		const folderPath = targetFolder ?? (await this.ensureNoteFolder(note.source, sourceConfig));
		const imageEmbeds = await this.writeAttachments(note, folderPath);
		await this.writeMarkdownFile(note, folderPath, sourceConfig, llmMarkdown, imageEmbeds);
	}

	private async streamMarkdownContent(
		note: ConvertedNote,
		folderPath: string,
		sourceConfig: SourceConfig,
		llm: LLMService,
		signal?: AbortSignal,
	) {
		const adapter = this.app.vault.adapter;
		const markdownPath = this.getMarkdownPath(note, folderPath);
		if (await adapter.exists(markdownPath)) {
			await adapter.remove(markdownPath);
		}
		await adapter.write(markdownPath, `${buildFrontMatter(note)}\n\n`);
		await this.maybeOpenGeneratedNote(note, folderPath, sourceConfig);
		await llm.streamMarkdown(
			note,
			async (chunk) => {
				if (!chunk) {
					return;
				}
				await adapter.append(markdownPath, chunk);
			},
			signal,
		);
	}

	private async appendPagesSection(
		note: ConvertedNote,
		folderPath: string,
		sourceConfig: SourceConfig,
		imageEmbeds: ImageEmbed[],
	) {
		const adapter = this.app.vault.adapter;
		const markdownPath = this.getMarkdownPath(note, folderPath);
		await adapter.append(markdownPath, `\n\n${buildPagesSection(imageEmbeds)}`);
		await this.maybeOpenGeneratedNote(note, folderPath, sourceConfig);
	}

	private async writeMarkdownFile(
		note: ConvertedNote,
		folderPath: string,
		sourceConfig: SourceConfig,
		llmMarkdown: string,
		imageEmbeds: ImageEmbed[],
	) {
		const adapter = this.app.vault.adapter;
		const markdownPath = this.getMarkdownPath(note, folderPath);
		const markdown = buildMarkdown({ note, llmMarkdown, imageEmbeds });
		if (await adapter.exists(markdownPath)) {
			await adapter.remove(markdownPath);
		}
		await adapter.write(markdownPath, markdown);
		await this.maybeOpenGeneratedNote(note, folderPath, sourceConfig);
	}

	private async writeAttachments(note: ConvertedNote, folderPath: string): Promise<ImageEmbed[]> {
		const adapter = this.app.vault.adapter;
		const imageEmbeds: ImageEmbed[] = [];
		for (const page of note.pages) {
			const imagePath = normalizePath(`${folderPath}/${page.fileName}`);
			imageEmbeds.push({ path: `./${page.fileName}`, width: page.width });
			await adapter.writeBinary(imagePath, bufferToArrayBuffer(page.data));
		}
		return imageEmbeds;
	}

	private getMarkdownPath(note: ConvertedNote, folderPath: string): string {
		return normalizePath(`${folderPath}/${note.source.basename}.md`);
	}

	private async maybeOpenGeneratedNote(note: ConvertedNote, folderPath: string, sourceConfig: SourceConfig) {
		if (!sourceConfig.openGeneratedNotes) {
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(this.getMarkdownPath(note, folderPath));
		if (!(file instanceof TFile)) {
			return;
		}
		const leaf = this.app.workspace.getLeaf(sourceConfig.openInNewLeaf);
		await leaf.openFile(file);
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
		this.statusBarEl.createSpan({ cls: 'ink2md-status-label', text: 'Ink2MD' });
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
					this.setStatus('Cancelling');
					new Notice('Cancelling current import...');
				return;
			}
			this.triggerImport().catch((error) => console.error(error));
		});
		this.setSpinner(false);
		this.setStatus('Idle');
	}

	private async activateDropzoneView(focus = false): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INK2MD_DROP);
		if (existing.length) {
				if (focus) {
					await this.app.workspace.revealLeaf(existing[0]!);
				}
			return;
		}
		const rightLeaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await rightLeaf.setViewState({ type: VIEW_TYPE_INK2MD_DROP, active: focus });
			if (focus) {
				await this.app.workspace.revealLeaf(rightLeaf);
			}
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
		} else {
			if (icon.classList.contains('is-spinning')) {
				this.pendingSpinnerStop = true;
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

	private async rememberProcessedSource(
		source: NoteSource,
		fingerprint?: SourceFingerprint,
		folderPath?: string,
		_sourceConfig?: SourceConfig,
	) {
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
			sourceId: source.sourceId,
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

	private async ensureNoteFolder(source: NoteSource, sourceConfig: SourceConfig, reusePath?: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		if (reusePath) {
			const normalizedReuse = normalizePath(reusePath);
			if (await adapter.exists(normalizedReuse)) {
				if (sourceConfig.replaceExisting) {
					await this.resetFolder(normalizedReuse);
				}
				return normalizedReuse;
			}
		}

		const root = this.resolveOutputRoot(sourceConfig);
		const relativeFolder = this.sanitizeRelativeFolder(source.relativeFolder);
		const baseFolder = this.joinPaths(root, relativeFolder);
		if (baseFolder) {
			await this.ensureDirectory(baseFolder);
		}

		const buildCandidate = (suffix: string) => this.joinPaths(baseFolder, suffix);
		let candidate = buildCandidate(source.basename);
		let counter = 1;
		while (candidate && (await adapter.exists(candidate))) {
			if (sourceConfig.replaceExisting) {
				await this.resetFolder(candidate);
				return candidate;
			}
			counter += 1;
			candidate = buildCandidate(`${source.basename}-${counter}`);
		}

		if (!candidate) {
			candidate = normalizePath(source.basename);
		}
		await this.ensureDirectory(candidate);
		return candidate;
	}

	private resolveOutputRoot(sourceConfig: SourceConfig): string {
		const configured = (sourceConfig.outputFolder ?? '').trim();
		if (!configured) {
			return normalizePath('Ink2MD');
		}
		if (configured === '/' || configured === '.') {
			return '';
		}
		return normalizePath(configured);
	}

	private sanitizeRelativeFolder(relative?: string): string {
		if (!relative) {
			return '';
		}
		const parts = relative
			.split(/[\\/]/)
			.map((part) => part.trim())
			.filter((part) => part && part !== '.' && part !== '..');
		return parts.join('/');
	}

	private joinPaths(...segments: Array<string | undefined>): string {
		const filtered = segments.filter((segment): segment is string => !!segment && segment.length > 0);
		if (!filtered.length) {
			return '';
		}
		return normalizePath(filtered.join('/'));
	}

	private async ensureDirectory(path: string) {
		const trimmed = path?.trim();
		if (!trimmed) {
			return;
		}
		const adapter = this.app.vault.adapter;
		const normalized = normalizePath(trimmed);
		const segments = normalized.split('/').filter(Boolean);
		if (!segments.length) {
			return;
		}
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!(await adapter.exists(current))) {
				await adapter.mkdir(current);
			}
		}
	}

	private getSecretStorage(): SecretStorage | null {
		const storage = this.app?.secretStorage;
		if (!storage) {
			return null;
		}
		if (typeof storage.getSecret !== 'function' || typeof storage.setSecret !== 'function') {
			return null;
		}
		return storage;
	}

	supportsSecretStorage(): boolean {
		return this.getSecretStorage() !== null;
	}

	private getSecretBindings(): Record<string, Partial<Record<SecretProvider, string>>> {
		if (!this.settings.secretBindings) {
			this.settings.secretBindings = {};
		}
		return this.settings.secretBindings;
	}

	private getSecretIdForPreset(presetId: string, provider: SecretProvider): string | null {
		const bindings = this.getSecretBindings()[presetId];
		return bindings?.[provider] ?? null;
	}

	getDropzoneSources(): SourceConfig[] {
		return (this.settings.sources ?? []).filter((source) => source.type === 'dropzone');
	}

	async stageDroppedFile(fileName: string, data: ArrayBuffer): Promise<string> {
		const dir = await this.ensureDropzoneCacheDir();
		const safeName = this.sanitizeTempFileName(fileName);
		const uniqueName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
		const stagedPath = path.join(dir, uniqueName);
		await fs.writeFile(stagedPath, Buffer.from(data));
		this.stagedFiles.add(stagedPath);
		return stagedPath;
	}

	async cleanupStagedFiles(paths: string[]) {
		for (const filePath of paths) {
			try {
				await fs.unlink(filePath);
			} catch (error) {
				console.warn(`[ink2md] Unable to delete staged file ${filePath}`, error);
			}
			this.stagedFiles.delete(filePath);
		}
	}

	private async ensureDropzoneCacheDir(): Promise<string> {
		if (this.dropzoneCacheDir) {
			return this.dropzoneCacheDir;
		}
		const dir = path.join(os.tmpdir(), 'ink2md-dropzone');
		await fs.mkdir(dir, { recursive: true });
		this.dropzoneCacheDir = dir;
		return dir;
	}

	private sanitizeTempFileName(name: string): string {
		const trimmed = name?.trim() || 'file';
		const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
		return sanitized || 'file';
	}

	private generateSecretSuffix(): string {
		const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let suffix = '';
		while (suffix.length < SECRET_SUFFIX_LENGTH) {
			const index = Math.floor(Math.random() * alphabet.length);
			suffix += alphabet.charAt(index);
		}
		return suffix;
	}

	private generateSecretId(provider: SecretProvider, existing = new Set<string>()): string {
		let attempt = '';
		do {
			attempt = `${PROVIDER_SECRET_PREFIX[provider]}${this.generateSecretSuffix()}`;
		} while (existing.has(attempt));
		return attempt;
	}

	private findReusableSecretId(storage: SecretStorage, provider: SecretProvider): string | null {
		if (typeof storage.listSecrets !== 'function') {
			return null;
		}
		const used = new Set<string>();
		for (const entry of Object.values(this.getSecretBindings())) {
			for (const value of Object.values(entry ?? {})) {
				used.add(value);
			}
		}
		try {
			const all = storage.listSecrets();
			for (const id of all) {
				if (typeof id !== 'string') {
					continue;
				}
				if (!id.startsWith(PROVIDER_SECRET_PREFIX[provider])) {
					continue;
				}
				if (!used.has(id)) {
					return id;
				}
			}
		} catch (error) {
			console.warn('[ink2md] Unable to enumerate secret storage entries.', error);
		}
		return null;
	}

	private ensureSecretBinding(presetId: string, provider: SecretProvider, storage: SecretStorage): string {
		const bindings = this.getSecretBindings();
		const presetBindings = (bindings[presetId] ??= {});
		const existingBinding = presetBindings[provider];
		if (existingBinding) {
			return existingBinding;
		}
		const reusable = this.findReusableSecretId(storage, provider);
		const existing = new Set<string>();
		for (const entry of Object.values(bindings)) {
			for (const value of Object.values(entry ?? {})) {
				existing.add(value);
			}
		}
		if (typeof storage.listSecrets === 'function') {
			try {
				for (const id of storage.listSecrets()) {
					if (typeof id === 'string' && id.startsWith(PROVIDER_SECRET_PREFIX[provider])) {
						existing.add(id);
					}
				}
			} catch (error) {
				console.warn('[ink2md] Unable to inspect secret storage entries while allocating binding.', error);
			}
		}
		const assigned = reusable ?? this.generateSecretId(provider, existing);
		presetBindings[provider] = assigned;
		return assigned;
	}

	getPresetSecretId(presetId: string, provider: SecretProvider = 'openai'): string | null {
		if (!this.supportsSecretStorage()) {
			return null;
		}
		return this.getSecretIdForPreset(presetId, provider);
	}

	private buildLegacySecretIds(presetId: string, provider: SecretProvider): string[] {
		if (provider !== 'openai') {
			return [];
		}
		const colonId = `${OPENAI_SECRET_ID}:${presetId}`;
		const sanitized = presetId
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const hyphenId = `${OPENAI_SECRET_ID}-${sanitized}`;
		return Array.from(new Set([colonId, hyphenId]));
	}

	private readOpenAISecretFromStore(presetId: string): string | null {
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			return preset?.openAI.apiKey?.trim() || null;
		}
		const binding = this.getSecretIdForPreset(presetId, 'openai');
		if (binding) {
			try {
				const secret = storage.getSecret(binding);
				const trimmed = typeof secret === 'string' ? secret.trim() : '';
				if (trimmed.length > 0) {
					return trimmed;
				}
			} catch (error) {
				console.warn('[ink2md] Unable to read OpenAI API key from secret storage.', error);
			}
		}
		const legacyIds = this.buildLegacySecretIds(presetId, 'openai');
		for (const candidate of legacyIds) {
			try {
				const secret = storage.getSecret(candidate);
				const trimmed = typeof secret === 'string' ? secret.trim() : '';
				if (trimmed.length > 0) {
					const target = binding ?? this.ensureSecretBinding(presetId, 'openai', storage);
					storage.setSecret(target, trimmed);
					return trimmed;
				}
			} catch (error) {
				console.warn('[ink2md] Unable to read OpenAI API key from legacy secret storage entry.', error);
			}
		}
		return null;
	}

	private readAzureOpenAISecretFromStore(presetId: string): string | null {
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			return preset?.azureOpenAI.apiKey?.trim() || null;
		}
		const binding = this.getSecretIdForPreset(presetId, 'azure-openai');
		if (binding) {
			try {
				const secret = storage.getSecret(binding);
				const trimmed = typeof secret === 'string' ? secret.trim() : '';
				if (trimmed.length > 0) {
					return trimmed;
				}
			} catch (error) {
				console.warn('[ink2md] Unable to read Azure OpenAI API key from secret storage.', error);
			}
		}
		return null;
	}

	private readGeminiSecretFromStore(presetId: string): string | null {
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			return preset?.gemini.apiKey?.trim() || null;
		}
		const binding = this.getSecretIdForPreset(presetId, 'gemini');
		if (binding) {
			try {
				const secret = storage.getSecret(binding);
				const trimmed = typeof secret === 'string' ? secret.trim() : '';
				if (trimmed.length > 0) {
					return trimmed;
				}
			} catch (error) {
				console.warn('[ink2md] Unable to read Gemini API key from secret storage.', error);
			}
		}
		return null;
	}

	getOpenAISecret(presetId: string): string {
		const cached = this.openAISecrets[presetId];
		if (cached && cached.length > 0) {
			return cached;
		}
		const secret = this.readOpenAISecretFromStore(presetId);
		this.openAISecrets[presetId] = secret;
		return secret ?? '';
	}

	hasOpenAISecret(presetId: string): boolean {
		return this.getOpenAISecret(presetId).length > 0;
	}

	async setOpenAISecret(presetId: string, value: string) {
		const trimmed = value.trim();
		this.openAISecrets[presetId] = trimmed.length > 0 ? trimmed : null;
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			if (preset) {
				preset.openAI.apiKey = trimmed;
			}
			if (trimmed.length === 0 && preset) {
				preset.openAI.apiKey = '';
			}
			if (!this.notifiedMissingSecretStorage) {
				this.notifiedMissingSecretStorage = true;
				new Notice('This Obsidian version does not support the secure key vault. Keys are stored with plugin settings instead.');
			}
			return;
		}
		try {
			const binding = this.ensureSecretBinding(presetId, 'openai', storage);
			storage.setSecret(binding, this.openAISecrets[presetId] ?? '');
		} catch (error) {
			console.error('[ink2md] Unable to persist OpenAI API key in secret storage.', error);
		}
	}

	async deleteOpenAISecret(presetId: string) {
		delete this.openAISecrets[presetId];
		const bindings = this.getSecretBindings();
		const entry = bindings[presetId];
		const binding = entry?.openai;
		const storage = this.getSecretStorage();
		if (binding && entry) {
			delete entry.openai;
			if (Object.keys(entry).length === 0) {
				delete bindings[presetId];
			}
			if (storage) {
				try {
					storage.setSecret(binding, '');
				} catch (error) {
					console.error('[ink2md] Unable to clear OpenAI API key from secret storage.', error);
				}
			}
		}
		const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
		if (preset) {
			preset.openAI.apiKey = '';
		}
	}

	getAzureOpenAISecret(presetId: string): string {
		const cached = this.azureOpenAISecrets[presetId];
		if (cached && cached.length > 0) {
			return cached;
		}
		const secret = this.readAzureOpenAISecretFromStore(presetId);
		this.azureOpenAISecrets[presetId] = secret;
		return secret ?? '';
	}

	hasAzureOpenAISecret(presetId: string): boolean {
		return this.getAzureOpenAISecret(presetId).length > 0;
	}

	async setAzureOpenAISecret(presetId: string, value: string) {
		const trimmed = value.trim();
		this.azureOpenAISecrets[presetId] = trimmed.length > 0 ? trimmed : null;
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			if (preset) {
				preset.azureOpenAI.apiKey = trimmed;
			}
			if (trimmed.length === 0 && preset) {
				preset.azureOpenAI.apiKey = '';
			}
			if (!this.notifiedMissingSecretStorage) {
				this.notifiedMissingSecretStorage = true;
				new Notice('This Obsidian version does not support the secure key vault. Keys are stored with plugin settings instead.');
			}
			return;
		}
		try {
			const binding = this.ensureSecretBinding(presetId, 'azure-openai', storage);
			storage.setSecret(binding, this.azureOpenAISecrets[presetId] ?? '');
		} catch (error) {
			console.error('[ink2md] Unable to persist Azure OpenAI API key in secret storage.', error);
		}
	}

	async deleteAzureOpenAISecret(presetId: string) {
		delete this.azureOpenAISecrets[presetId];
		const bindings = this.getSecretBindings();
		const entry = bindings[presetId];
		const binding = entry?.['azure-openai'];
		const storage = this.getSecretStorage();
		if (binding && entry) {
			delete entry['azure-openai'];
			if (Object.keys(entry).length === 0) {
				delete bindings[presetId];
			}
			if (storage) {
				try {
					storage.setSecret(binding, '');
				} catch (error) {
					console.error('[ink2md] Unable to clear Azure OpenAI API key from secret storage.', error);
				}
			}
		}
		const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
		if (preset) {
			preset.azureOpenAI.apiKey = '';
		}
	}

	getGeminiSecret(presetId: string): string {
		const cached = this.geminiSecrets[presetId];
		if (cached && cached.length > 0) {
			return cached;
		}
		const secret = this.readGeminiSecretFromStore(presetId);
		this.geminiSecrets[presetId] = secret;
		return secret ?? '';
	}

	hasGeminiSecret(presetId: string): boolean {
		return this.getGeminiSecret(presetId).length > 0;
	}

	async setGeminiSecret(presetId: string, value: string) {
		const trimmed = value.trim();
		this.geminiSecrets[presetId] = trimmed.length > 0 ? trimmed : null;
		const storage = this.getSecretStorage();
		if (!storage) {
			const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
			if (preset) {
				preset.gemini.apiKey = trimmed;
			}
			if (trimmed.length === 0 && preset) {
				preset.gemini.apiKey = '';
			}
			if (!this.notifiedMissingSecretStorage) {
				this.notifiedMissingSecretStorage = true;
				new Notice('This Obsidian version does not support the secure key vault. Keys are stored with plugin settings instead.');
			}
			return;
		}
		try {
			const binding = this.ensureSecretBinding(presetId, 'gemini', storage);
			storage.setSecret(binding, this.geminiSecrets[presetId] ?? '');
		} catch (error) {
			console.error('[ink2md] Unable to persist Gemini API key in secret storage.', error);
		}
	}

	async deleteGeminiSecret(presetId: string) {
		delete this.geminiSecrets[presetId];
		const bindings = this.getSecretBindings();
		const entry = bindings[presetId];
		const binding = entry?.gemini;
		const storage = this.getSecretStorage();
		if (binding && entry) {
			delete entry.gemini;
			if (Object.keys(entry).length === 0) {
				delete bindings[presetId];
			}
			if (storage) {
				try {
					storage.setSecret(binding, '');
				} catch (error) {
					console.error('[ink2md] Unable to clear Gemini API key from secret storage.', error);
				}
			}
		}
		const preset = this.settings.llmPresets.find((entry) => entry.id === presetId);
		if (preset) {
			preset.gemini.apiKey = '';
		}
	}

	async loadSettings() {
		const storedData: unknown = await this.loadData();
		const stored: StoredSettingsSnapshot | null = isStoredSettingsSnapshot(storedData) ? storedData : null;
		let normalized: {
			settings: Ink2MDSettings;
			openAIKeys: Record<string, string>;
			azureOpenAIKeys: Record<string, string>;
			geminiKeys: Record<string, string>;
		};
		if (!stored || !Array.isArray(stored.sources) || !Array.isArray(stored.llmPresets)) {
			normalized = this.migrateLegacySettings(stored ?? undefined);
		} else {
			normalized = this.normalizeSettings(stored);
		}
		this.settings = normalized.settings;
		this.initializeOpenAISecrets(normalized.openAIKeys);
		this.initializeAzureOpenAISecrets(normalized.azureOpenAIKeys);
		this.initializeGeminiSecrets(normalized.geminiKeys);
	}

	async saveSettings() {
		for (const preset of this.settings.llmPresets) {
			preset.openAI.apiKey = '';
			preset.azureOpenAI.apiKey = '';
			preset.gemini.apiKey = '';
		}
		await this.saveData(this.settings);
		this.refreshDropzoneViews();
	}

	private refreshDropzoneViews() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INK2MD_DROP);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof Ink2MDDropView) {
				view.refresh();
			}
		}
	}

	private normalizeSettings(
		raw: StoredSettingsSnapshot,
	): {
		settings: Ink2MDSettings;
		openAIKeys: Record<string, string>;
		azureOpenAIKeys: Record<string, string>;
		geminiKeys: Record<string, string>;
	} {
		const defaultPresetTemplate = DEFAULT_SETTINGS.llmPresets[0]!;
		const defaultSourceTemplate =
			DEFAULT_SETTINGS.sources.find((source) => source.type === 'filesystem') ?? DEFAULT_SETTINGS.sources[0]!;
		const defaultDropzoneTemplate =
			DEFAULT_SETTINGS.sources.find((source) => source.type === 'dropzone') ?? defaultSourceTemplate;
		const rawPresets = Array.isArray(raw.llmPresets) && raw.llmPresets.length ? raw.llmPresets : DEFAULT_SETTINGS.llmPresets;
		const presets: LLMPreset[] = rawPresets.map((preset, index) => this.normalizePreset(preset, defaultPresetTemplate, index));
		if (!presets.length) {
			presets.push(this.normalizePreset(undefined, defaultPresetTemplate, 0));
		}
		const presetIds = new Set(presets.map((preset) => preset.id));
		const primaryPresetId = presets[0]!.id;
		const rawSources = Array.isArray(raw.sources) && raw.sources.length ? raw.sources : DEFAULT_SETTINGS.sources;
		const sources: SourceConfig[] = rawSources.map((source, index) =>
			this.normalizeSource(source, defaultSourceTemplate, presetIds, primaryPresetId, index),
		);
		if (!sources.length) {
			sources.push(this.normalizeSource(undefined, defaultSourceTemplate, presetIds, primaryPresetId, 0));
		}
		const dropzonePresetId = presetIds.has(defaultPresetTemplate.id) ? defaultPresetTemplate.id : primaryPresetId;
		if (!sources.some((source) => source.type === 'dropzone')) {
			const dropzoneBase: SourceConfig = {
				...defaultDropzoneTemplate,
				id: this.generateId('source'),
				label: defaultDropzoneTemplate.label ?? 'Dropzone',
				type: 'dropzone',
				directories: [],
				recursive: false,
				llmPresetId: dropzonePresetId,
			};
			sources.push(
				this.normalizeSource(dropzoneBase, defaultDropzoneTemplate, presetIds, primaryPresetId, sources.length),
			);
		}
		const processedSources: Record<string, ProcessedSourceInfo> = {};
		const rawProcessed = raw.processedSources ?? {};
		const fallbackSourceId = sources[0]!.id;
		for (const [key, entry] of Object.entries(rawProcessed)) {
			if (!isProcessedSourceInfo(entry)) {
				continue;
			}
			processedSources[key] = {
				...entry,
				sourceId: entry.sourceId ?? fallbackSourceId,
			};
		}
		const openAIKeys: Record<string, string> = {};
		const azureOpenAIKeys: Record<string, string> = {};
		const geminiKeys: Record<string, string> = {};
		for (const preset of presets) {
			if (preset.openAI.apiKey) {
				openAIKeys[preset.id] = preset.openAI.apiKey;
			}
			if (preset.azureOpenAI?.apiKey) {
				azureOpenAIKeys[preset.id] = preset.azureOpenAI.apiKey;
			}
			if (preset.gemini?.apiKey) {
				geminiKeys[preset.id] = preset.gemini.apiKey;
			}
		}
		const rawBindings = raw.secretBindings ?? {};
		const secretBindings: Record<string, Partial<Record<SecretProvider, string>>> = {};
		if (rawBindings && typeof rawBindings === 'object') {
			for (const [presetId, binding] of Object.entries(rawBindings)) {
				if (!presetIds.has(presetId)) {
					continue;
				}
				if (typeof binding === 'string') {
					if (binding.startsWith(PROVIDER_SECRET_PREFIX.openai)) {
						secretBindings[presetId] = { openai: binding };
					}
					continue;
				}
				if (isRecord(binding)) {
					const entry: Partial<Record<SecretProvider, string>> = {};
					for (const [providerKey, secretId] of Object.entries(binding)) {
						if (providerKey === 'openai' || providerKey === 'azure-openai' || providerKey === 'gemini') {
							if (typeof secretId !== 'string') {
								continue;
							}
							const typedKey = providerKey as SecretProvider;
							if (secretId.startsWith(PROVIDER_SECRET_PREFIX[typedKey])) {
								entry[typedKey] = secretId;
							}
						}
					}
					if (Object.keys(entry).length) {
						secretBindings[presetId] = entry;
					}
				}
			}
		}
		return {
			settings: {
				sources,
				llmPresets: presets,
				processedSources,
				secretBindings,
			},
			openAIKeys,
			azureOpenAIKeys,
			geminiKeys,
		};
	}

	private migrateLegacySettings(raw: LegacySettingsSnapshot | null | undefined): {
		settings: Ink2MDSettings;
		openAIKeys: Record<string, string>;
		azureOpenAIKeys: Record<string, string>;
		geminiKeys: Record<string, string>;
	} {
		const presetId = this.generateId('preset');
		const sourceId = this.generateId('source');
		const openAIKeys: Record<string, string> = {};
		const azureOpenAIKeys: Record<string, string> = {};
		const geminiKeys: Record<string, string> = {};
		const legacyProvider = raw?.llmProvider ?? 'openai';
		const legacyGenerationMode = raw?.llmGenerationMode ?? 'batch';
		const defaultPresetTemplate = DEFAULT_SETTINGS.llmPresets[0]!;
		const defaultSourceTemplate = DEFAULT_SETTINGS.sources[0]!;
		const legacyPrompt = raw?.openAI?.promptTemplate ?? defaultPresetTemplate.openAI.promptTemplate;
		const legacyLocalPrompt = raw?.local?.promptTemplate ?? defaultPresetTemplate.local.promptTemplate;
		const preset: LLMPreset = {
			id: presetId,
			label: 'Default preset',
			provider: legacyProvider,
			generationMode: legacyGenerationMode,
			llmMaxWidth: raw?.llmMaxWidth ?? defaultPresetTemplate.llmMaxWidth,
			openAI: {
				...defaultPresetTemplate.openAI,
				...(raw?.openAI ?? {}),
				promptTemplate: legacyPrompt,
			},
			azureOpenAI: {
				...defaultPresetTemplate.azureOpenAI,
				...(raw?.azureOpenAI ?? {}),
			},
			local: {
				...defaultPresetTemplate.local,
				...(raw?.local ?? {}),
				promptTemplate: legacyLocalPrompt,
			},
			gemini: {
				...defaultPresetTemplate.gemini,
			},
		};
		if (preset.openAI.apiKey) {
			openAIKeys[preset.id] = preset.openAI.apiKey;
		}
		if (preset.azureOpenAI.apiKey) {
			azureOpenAIKeys[preset.id] = preset.azureOpenAI.apiKey;
		}
		const legacyDirectories = Array.isArray(raw?.inputDirectories)
			? raw.inputDirectories.filter((entry): entry is string => typeof entry === 'string')
			: [];
		const source: SourceConfig = {
				...defaultSourceTemplate,
				id: sourceId,
				label: 'Default source',
				directories: legacyDirectories,
			recursive: true,
			includeImages: raw?.includeImages ?? true,
			includePdfs: raw?.includePdfs ?? true,
			attachmentMaxWidth: raw?.attachmentMaxWidth ?? raw?.maxImageWidth ?? defaultSourceTemplate.attachmentMaxWidth,
			pdfDpi: raw?.pdfDpi ?? defaultSourceTemplate.pdfDpi,
			replaceExisting: raw?.replaceExisting ?? defaultSourceTemplate.replaceExisting,
			outputFolder: raw?.outputFolder ?? defaultSourceTemplate.outputFolder,
			openGeneratedNotes: raw?.openGeneratedNotes ?? defaultSourceTemplate.openGeneratedNotes,
			openInNewLeaf: true,
			llmPresetId: presetId,
			type: 'filesystem',
			preImportScript: '',
		};
		const processedSources: Record<string, ProcessedSourceInfo> = {};
		const rawProcessed = raw?.processedSources ?? {};
		for (const [key, entry] of Object.entries(rawProcessed)) {
			if (!isProcessedSourceInfo(entry)) {
				continue;
			}
			processedSources[key] = {
				...entry,
				sourceId,
			};
		}
		return {
			settings: {
				sources: [source],
				llmPresets: [preset],
				processedSources,
				secretBindings: {},
			},
			openAIKeys,
			azureOpenAIKeys,
			geminiKeys,
		};
	}

	private normalizePreset(
		preset: Partial<LLMPreset> | undefined,
		fallback: LLMPreset,
		index: number,
	): LLMPreset {
		const base = preset ?? {};
		const id = base.id && base.id.trim().length ? base.id : this.generateId('preset');
		return {
			id,
			label: base.label?.trim() || `Preset ${index + 1}`,
			provider: base.provider ?? fallback.provider,
			generationMode: base.generationMode ?? fallback.generationMode,
			llmMaxWidth: base.llmMaxWidth ?? fallback.llmMaxWidth,
			openAI: {
				...fallback.openAI,
				...(base.openAI ?? {}),
			},
			azureOpenAI: {
				...fallback.azureOpenAI,
				...(base.azureOpenAI ?? {}),
			},
			local: {
				...fallback.local,
				...(base.local ?? {}),
			},
			gemini: {
				...fallback.gemini,
				...(base.gemini ?? {}),
			},
		};
	}

	private normalizeSource(
		source: Partial<SourceConfig> | undefined,
		fallback: SourceConfig,
		presetIds: Set<string>,
		defaultPresetId: string,
		index: number,
	): SourceConfig {
		const base = source ?? {};
		const id = base.id && base.id.trim().length ? base.id : this.generateId('source');
		const directories = Array.isArray(base.directories) ? base.directories.filter((dir) => typeof dir === 'string' && dir.trim().length > 0) : [];
		const requestedPreset = base.llmPresetId && presetIds.has(base.llmPresetId) ? base.llmPresetId : defaultPresetId;
		const preImportScript = typeof base.preImportScript === 'string'
			? base.preImportScript.trim()
			: (fallback.preImportScript ?? '');
		return {
			...fallback,
			...base,
			id,
			label: base.label?.trim() || `Source ${index + 1}`,
			type: base.type ?? fallback.type ?? 'filesystem',
			directories,
			recursive: base.recursive ?? fallback.recursive,
			includeImages: base.includeImages ?? fallback.includeImages,
			includePdfs: base.includePdfs ?? fallback.includePdfs,
			attachmentMaxWidth: base.attachmentMaxWidth ?? fallback.attachmentMaxWidth,
			pdfDpi: base.pdfDpi ?? fallback.pdfDpi,
			replaceExisting: base.replaceExisting ?? fallback.replaceExisting,
			outputFolder: base.outputFolder ?? fallback.outputFolder,
			openGeneratedNotes: base.openGeneratedNotes ?? fallback.openGeneratedNotes,
			openInNewLeaf: base.openInNewLeaf ?? fallback.openInNewLeaf,
			llmPresetId: requestedPreset,
			preImportScript,
		};
	}

	private initializeOpenAISecrets(initialKeys: Record<string, string>) {
		this.openAISecrets = {};
		const storage = this.getSecretStorage();
		if (!storage) {
			if (Object.keys(initialKeys).length) {
				console.warn('[ink2md] Secret storage unavailable; unable to migrate stored OpenAI API keys.');
					new Notice('Secure key storage is unavailable. Update Obsidian to keep your API keys saved.');
			}
			this.settings.secretBindings = {};
			for (const preset of this.settings.llmPresets) {
				const initial = initialKeys[preset.id]?.trim() || '';
				this.openAISecrets[preset.id] = initial || null;
				preset.openAI.apiKey = initial;
			}
			return;
		}
		for (const preset of this.settings.llmPresets) {
			const initial = initialKeys[preset.id]?.trim();
			if (initial) {
				try {
					const binding = this.ensureSecretBinding(preset.id, 'openai', storage);
					storage.setSecret(binding, initial);
				} catch (error) {
					console.error('[ink2md] Unable to migrate OpenAI API key into secret storage.', error);
				}
			}
			const resolved = this.readOpenAISecretFromStore(preset.id);
			this.openAISecrets[preset.id] = resolved;
			preset.openAI.apiKey = '';
		}
	}

	private initializeAzureOpenAISecrets(initialKeys: Record<string, string>) {
		this.azureOpenAISecrets = {};
		const storage = this.getSecretStorage();
		if (!storage) {
			if (Object.keys(initialKeys).length) {
				console.warn('[ink2md] Secret storage unavailable; unable to migrate stored Azure OpenAI API keys.');
			}
			for (const preset of this.settings.llmPresets) {
				const initial = initialKeys[preset.id]?.trim() || '';
				this.azureOpenAISecrets[preset.id] = initial || null;
				preset.azureOpenAI.apiKey = initial;
			}
			return;
		}
		for (const preset of this.settings.llmPresets) {
			const initial = initialKeys[preset.id]?.trim();
			if (initial) {
				try {
					const binding = this.ensureSecretBinding(preset.id, 'azure-openai', storage);
					storage.setSecret(binding, initial);
				} catch (error) {
					console.error('[ink2md] Unable to migrate Azure OpenAI API key into secret storage.', error);
				}
			}
			const resolved = this.readAzureOpenAISecretFromStore(preset.id);
			this.azureOpenAISecrets[preset.id] = resolved;
			preset.azureOpenAI.apiKey = '';
		}
	}

	private initializeGeminiSecrets(initialKeys: Record<string, string>) {
		this.geminiSecrets = {};
		const storage = this.getSecretStorage();
		if (!storage) {
			if (Object.keys(initialKeys).length) {
				console.warn('[ink2md] Secret storage unavailable; unable to migrate stored Gemini API keys.');
			}
			for (const preset of this.settings.llmPresets) {
				const initial = initialKeys[preset.id]?.trim() || '';
				this.geminiSecrets[preset.id] = initial || null;
				preset.gemini.apiKey = initial;
			}
			return;
		}
		for (const preset of this.settings.llmPresets) {
			const initial = initialKeys[preset.id]?.trim();
			if (initial) {
				try {
					const binding = this.ensureSecretBinding(preset.id, 'gemini', storage);
					storage.setSecret(binding, initial);
				} catch (error) {
					console.error('[ink2md] Unable to migrate Gemini API key into secret storage.', error);
				}
			}
			const resolved = this.readGeminiSecretFromStore(preset.id);
			this.geminiSecrets[preset.id] = resolved;
			preset.gemini.apiKey = '';
		}
	}

	private generateId(prefix: string): string {
		return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		const legacyPath = (adapter as { basePath?: string }).basePath;
		return typeof legacyPath === 'string' ? legacyPath : null;
	}
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
