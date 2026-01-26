import { promises as fs } from 'fs';
import { Notice, Plugin, TFile, normalizePath, setIcon, setTooltip } from 'obsidian';
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
} from './types';
import { discoverNoteSourcesForConfig } from './importers';
import { convertSourceToPng } from './conversion';
import { LLMService } from './llm';
import { buildMarkdown, buildFrontMatter, buildPagesSection } from './markdown/generator';
import { hashFile } from './utils/hash';

const OPENAI_SECRET_ID = 'ink2md-openai-api-key';
const OPENAI_SECRET_PREFIX = `${OPENAI_SECRET_ID}-`;
const OPENAI_SECRET_SUFFIX_LENGTH = 10;

type SourceFingerprint = {
	hash: string;
	size: number;
	mtimeMs: number;
};
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

	export default class Ink2MDPlugin extends Plugin {
	settings: Ink2MDSettings;
	private statusBarEl: HTMLElement | null = null;
	private statusIconEl: HTMLElement | null = null;
	private isImporting = false;
	private cancelRequested = false;
	private abortController: AbortController | null = null;
	private pendingSpinnerStop = false;
	private openAISecrets: Record<string, string | null> = {};
	private notifiedMissingSecretStorage = false;

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
		const jobs = await this.collectImportJobs();
		if (!jobs.length) {
			new Notice('Ink2MD: no sources are ready to import. Configure at least one source with directories and an LLM preset.');
			finalStatus = 'Configuration required';
			this.setStatus(finalStatus);
			return;
		}

		new Notice('Ink2MD: scanning input directories...');
		this.setStatus('Scanning for handwritten notes...');
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

	private async collectImportJobs(): Promise<ImportJob[]> {
		const jobs: ImportJob[] = [];
		const sources = this.settings.sources ?? [];
		if (!sources.length) {
			return jobs;
		}

		for (const sourceConfig of sources) {
			if (sourceConfig.type !== 'filesystem') {
				console.warn(`[ink2md] Unsupported source type ${sourceConfig.type} for ${sourceConfig.label}`);
				continue;
			}
			if (!sourceConfig.directories.length) {
				new Notice(`Ink2MD: source "${sourceConfig.label}" has no directories configured.`);
				continue;
			}
			if (!sourceConfig.llmPresetId) {
				new Notice(`Ink2MD: source "${sourceConfig.label}" is missing an LLM preset.`);
				continue;
			}
			const preset = this.getRuntimePreset(sourceConfig.llmPresetId);
			if (!preset) {
				new Notice(`Ink2MD: preset linked to "${sourceConfig.label}" was not found.`);
				continue;
			}
			if (preset.provider === 'openai' && !preset.openAI.apiKey) {
				new Notice(`Ink2MD: preset "${preset.label}" requires an OpenAI API key.`);
				continue;
			}
			const notes = await discoverNoteSourcesForConfig(sourceConfig);
			for (const note of notes) {
				jobs.push({ note, sourceConfig, preset });
			}
		}

		return jobs;
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
		const apiKey = preset.provider === 'openai' ? this.getOpenAISecret(preset.id) || preset.openAI.apiKey : preset.openAI.apiKey;
		return {
			...preset,
			openAI: {
				...preset.openAI,
				apiKey: apiKey ?? '',
			},
			local: {
				...preset.local,
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

	private getSecretBindings(): Record<string, string> {
		if (!this.settings.secretBindings) {
			this.settings.secretBindings = {};
		}
		return this.settings.secretBindings;
	}

	private getSecretIdForPreset(presetId: string): string | null {
		return this.getSecretBindings()[presetId] ?? null;
	}

	private generateSecretSuffix(): string {
		const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let suffix = '';
		while (suffix.length < OPENAI_SECRET_SUFFIX_LENGTH) {
			const index = Math.floor(Math.random() * alphabet.length);
			suffix += alphabet.charAt(index);
		}
		return suffix;
	}

	private generateSecretId(existing = new Set<string>()): string {
		let attempt = '';
		do {
			attempt = `${OPENAI_SECRET_PREFIX}${this.generateSecretSuffix()}`;
		} while (existing.has(attempt));
		return attempt;
	}

	private findReusableSecretId(storage: SecretStorage): string | null {
		if (typeof storage.listSecrets !== 'function') {
			return null;
		}
		const used = new Set(Object.values(this.getSecretBindings()));
		try {
			const all = storage.listSecrets();
			for (const id of all) {
				if (typeof id !== 'string') {
					continue;
				}
				if (!id.startsWith(OPENAI_SECRET_PREFIX)) {
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

	private ensureSecretBinding(presetId: string, storage: SecretStorage): string {
		const bindings = this.getSecretBindings();
		if (bindings[presetId]) {
			return bindings[presetId];
		}
		const reusable = this.findReusableSecretId(storage);
		const existing = new Set(Object.values(bindings));
		if (typeof storage.listSecrets === 'function') {
			try {
				for (const id of storage.listSecrets()) {
					if (typeof id === 'string' && id.startsWith(OPENAI_SECRET_PREFIX)) {
						existing.add(id);
					}
				}
			} catch (error) {
				console.warn('[ink2md] Unable to inspect secret storage entries while allocating binding.', error);
			}
		}
		const assigned = reusable ?? this.generateSecretId(existing);
		bindings[presetId] = assigned;
		return assigned;
	}

	getPresetSecretId(presetId: string): string | null {
		if (!this.supportsSecretStorage()) {
			return null;
		}
		return this.getSecretIdForPreset(presetId);
	}

	private buildLegacySecretIds(presetId: string): string[] {
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
		const binding = this.getSecretIdForPreset(presetId);
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
		const legacyIds = this.buildLegacySecretIds(presetId);
		for (const candidate of legacyIds) {
			try {
				const secret = storage.getSecret(candidate);
				const trimmed = typeof secret === 'string' ? secret.trim() : '';
				if (trimmed.length > 0) {
					const target = binding ?? this.ensureSecretBinding(presetId, storage);
					storage.setSecret(target, trimmed);
					return trimmed;
				}
			} catch (error) {
				console.warn('[ink2md] Unable to read OpenAI API key from legacy secret storage entry.', error);
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
				new Notice('Ink2MD: this Obsidian version does not support the secure key vault. Keys are stored with plugin settings instead.');
			}
			return;
		}
		try {
			const binding = this.ensureSecretBinding(presetId, storage);
			storage.setSecret(binding, this.openAISecrets[presetId] ?? '');
		} catch (error) {
			console.error('[ink2md] Unable to persist OpenAI API key in secret storage.', error);
		}
	}

	async deleteOpenAISecret(presetId: string) {
		delete this.openAISecrets[presetId];
		const bindings = this.getSecretBindings();
		const binding = bindings[presetId];
		const storage = this.getSecretStorage();
		if (binding) {
			delete bindings[presetId];
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

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<Ink2MDSettings> | null;
		let normalized: { settings: Ink2MDSettings; openAIKeys: Record<string, string> };
		if (!stored || !Array.isArray((stored as Ink2MDSettings).sources) || !Array.isArray((stored as Ink2MDSettings).llmPresets)) {
			normalized = this.migrateLegacySettings(stored ?? {});
		} else {
			normalized = this.normalizeSettings(stored as Partial<Ink2MDSettings>);
		}
		this.settings = normalized.settings;
		this.initializeOpenAISecrets(normalized.openAIKeys);
	}

	async saveSettings() {
		for (const preset of this.settings.llmPresets) {
			preset.openAI.apiKey = '';
		}
		await this.saveData(this.settings);
	}

	private normalizeSettings(raw: Partial<Ink2MDSettings>): { settings: Ink2MDSettings; openAIKeys: Record<string, string> } {
		const defaultPresetTemplate = DEFAULT_SETTINGS.llmPresets[0]!;
		const defaultSourceTemplate = DEFAULT_SETTINGS.sources[0]!;
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
		const processedSources: Record<string, ProcessedSourceInfo> = {};
		const rawProcessed = raw.processedSources ?? {};
		const fallbackSourceId = sources[0]!.id;
		for (const [key, entry] of Object.entries(rawProcessed)) {
			const info = entry as ProcessedSourceInfo;
			processedSources[key] = {
				...info,
				sourceId: info?.sourceId ?? fallbackSourceId,
			};
		}
		const openAIKeys: Record<string, string> = {};
		for (const preset of presets) {
			if (preset.openAI.apiKey) {
				openAIKeys[preset.id] = preset.openAI.apiKey;
			}
		}
		const rawBindings = (raw as Ink2MDSettings)?.secretBindings ?? {};
		const secretBindings: Record<string, string> = {};
		if (rawBindings && typeof rawBindings === 'object') {
			for (const [presetId, secretId] of Object.entries(rawBindings)) {
				if (!presetIds.has(presetId)) {
					continue;
				}
				if (typeof secretId === 'string' && secretId.startsWith(OPENAI_SECRET_PREFIX)) {
					secretBindings[presetId] = secretId;
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
		};
	}

	private migrateLegacySettings(raw: any): { settings: Ink2MDSettings; openAIKeys: Record<string, string> } {
		const presetId = this.generateId('preset');
		const sourceId = this.generateId('source');
		const openAIKeys: Record<string, string> = {};
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
			local: {
				...defaultPresetTemplate.local,
				...(raw?.local ?? {}),
				promptTemplate: legacyLocalPrompt,
			},
		};
		if (preset.openAI.apiKey) {
			openAIKeys[preset.id] = preset.openAI.apiKey;
		}
		const source: SourceConfig = {
			...defaultSourceTemplate,
			id: sourceId,
			label: 'Default source',
			directories: Array.isArray(raw?.inputDirectories) ? raw.inputDirectories : [],
			recursive: true,
			includeImages: raw?.includeImages ?? true,
			includePdfs: raw?.includePdfs ?? true,
			includeSupernote: raw?.includeSupernote ?? true,
			attachmentMaxWidth: raw?.attachmentMaxWidth ?? raw?.maxImageWidth ?? defaultSourceTemplate.attachmentMaxWidth,
			pdfDpi: raw?.pdfDpi ?? defaultSourceTemplate.pdfDpi,
			replaceExisting: raw?.replaceExisting ?? defaultSourceTemplate.replaceExisting,
			outputFolder: raw?.outputFolder ?? defaultSourceTemplate.outputFolder,
			openGeneratedNotes: raw?.openGeneratedNotes ?? defaultSourceTemplate.openGeneratedNotes,
			openInNewLeaf: true,
			llmPresetId: presetId,
			type: 'filesystem',
		};
		const processedSources: Record<string, ProcessedSourceInfo> = {};
		const rawProcessed = raw?.processedSources ?? {};
		for (const [key, entry] of Object.entries(rawProcessed)) {
			const info = entry as ProcessedSourceInfo;
			processedSources[key] = {
				...info,
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
			local: {
				...fallback.local,
				...(base.local ?? {}),
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
			includeSupernote: base.includeSupernote ?? fallback.includeSupernote,
			attachmentMaxWidth: base.attachmentMaxWidth ?? fallback.attachmentMaxWidth,
			pdfDpi: base.pdfDpi ?? fallback.pdfDpi,
			replaceExisting: base.replaceExisting ?? fallback.replaceExisting,
			outputFolder: base.outputFolder ?? fallback.outputFolder,
			openGeneratedNotes: base.openGeneratedNotes ?? fallback.openGeneratedNotes,
			openInNewLeaf: base.openInNewLeaf ?? fallback.openInNewLeaf,
			llmPresetId: requestedPreset,
		};
	}

	private initializeOpenAISecrets(initialKeys: Record<string, string>) {
		this.openAISecrets = {};
		const storage = this.getSecretStorage();
		if (!storage) {
			if (Object.keys(initialKeys).length) {
				console.warn('[ink2md] Secret storage unavailable; unable to migrate stored OpenAI API keys.');
				new Notice('Ink2MD: secure key storage is unavailable. Update Obsidian to keep your OpenAI API keys saved.');
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
					const binding = this.ensureSecretBinding(preset.id, storage);
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

	private generateId(prefix: string): string {
		return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
