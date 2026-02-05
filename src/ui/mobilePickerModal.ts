import { Modal, Notice } from 'obsidian';
import type Ink2MDPlugin from '../main';
import type { SourceConfig } from '../types';

export class MobilePickerModal extends Modal {
	private fileInput: HTMLInputElement | null = null;
	private statusEl: HTMLElement | null = null;
	private sourceSelect: HTMLSelectElement | null = null;

	constructor(private readonly plugin: Ink2MDPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ink2md-mobile-picker');

		const sources = this.plugin.getDropzoneSources();
		if (!sources.length) {
			contentEl.createEl('p', {
				text: 'Create a dropzone source in settings to import files from the picker.',
			});
			return;
		}

		contentEl.createEl('h3', { text: 'Import handwritten notes' });
		contentEl.createEl('p', {
			text: 'Select images or PDF files to import using the mobile file picker.',
		});

		const sourceLabel = contentEl.createEl('label', { text: 'Source' });
		sourceLabel.addClass('ink2md-mobile-picker-label');
		this.sourceSelect = contentEl.createEl('select');
		this.sourceSelect.addClass('ink2md-mobile-picker-select');
		for (const source of sources) {
			this.sourceSelect.createEl('option', { value: source.id, text: source.label });
		}
		this.sourceSelect.value = sources[0]?.id ?? '';
		this.sourceSelect.addEventListener('change', () => {
			this.updateFileAccept();
		});

		const actions = contentEl.createDiv({ cls: 'ink2md-mobile-picker-actions' });
		const browseButton = actions.createEl('button', { text: 'Select files' });
		browseButton.addEventListener('click', () => this.fileInput?.click());

		this.fileInput = contentEl.createEl('input', { type: 'file' });
		this.fileInput.addClass('ink2md-hidden-input');
		this.fileInput.multiple = true;
		this.updateFileAccept();
		this.fileInput.addEventListener('change', () => {
			void this.handleSelectedFiles(Array.from(this.fileInput?.files ?? []));
			if (this.fileInput) {
				this.fileInput.value = '';
			}
		});

		this.statusEl = contentEl.createDiv({ cls: 'ink2md-mobile-picker-status', text: 'Waiting for files...' });
	}

	private updateFileAccept(): void {
		if (!this.fileInput) {
			return;
		}
		this.fileInput.accept = buildAcceptList(this.getSelectedSource());
	}

	private getSelectedSource(): SourceConfig | null {
		const sources = this.plugin.getDropzoneSources();
		const selectedId = this.sourceSelect?.value;
		return sources.find((source) => source.id === selectedId) ?? sources[0] ?? null;
	}

	private async handleSelectedFiles(files: File[]): Promise<void> {
		if (!files.length) {
			this.setStatus('No files selected.');
			return;
		}
		const source = this.getSelectedSource();
		if (!source) {
			new Notice('Configure a dropzone source first.');
			return;
		}
		const { entries, staged } = await this.resolveFilePaths(files);
		if (!entries.length) {
			new Notice('Unable to read file paths from the selected files.');
			return;
		}
		const paths = entries.map((entry) => entry.path);
		const metadata: Record<string, { displayName?: string }> = {};
		for (const entry of entries) {
			if (entry.displayName) {
				metadata[entry.path] = { displayName: entry.displayName };
			}
		}
		this.setStatus(`Importing ${paths.length} file${paths.length === 1 ? '' : 's'}...`);
		try {
			await this.plugin.importDroppedFiles(source.id, paths, metadata);
			this.setStatus('Files queued for import.');
		} catch (error) {
			console.error('[ink2md] Failed to import selected files', error);
			this.setStatus('Import failed. Check logs for details.');
		} finally {
			if (staged.length) {
				await this.plugin.cleanupStagedFiles(staged);
			}
		}
	}

	private async resolveFilePaths(files: File[]): Promise<{ entries: Array<{ path: string; displayName?: string }>; staged: string[] }> {
		const entries: Array<{ path: string; displayName?: string }> = [];
		const staged: string[] = [];
		for (const file of files) {
			const nativePath = (file as File & { path?: string }).path;
			if (nativePath && nativePath.length > 0) {
				const trimmed = nativePath.trim();
				entries.push({ path: trimmed, displayName: file.name?.trim() });
				continue;
			}
			try {
				const buffer = await file.arrayBuffer();
				const stagedResult = await this.plugin.stageDroppedFile(file.name ?? 'file', buffer);
				const stagedPath = stagedResult.path.trim();
				entries.push({ path: stagedPath, displayName: stagedResult.displayName });
				staged.push(stagedPath);
			} catch (error) {
				console.error('[ink2md] Unable to stage picked file', error);
			}
		}
		return { entries, staged };
	}

	private setStatus(message: string): void {
		if (this.statusEl) {
			this.statusEl.setText(message);
		}
	}
}

export function buildAcceptList(source: SourceConfig | null): string {
	if (!source) {
		return '';
	}
	const accepts: string[] = [];
	if (source.includeImages) {
		accepts.push('.png', '.jpg', '.jpeg', '.webp');
	}
	if (source.includePdfs) {
		accepts.push('.pdf');
	}
	return accepts.join(',');
}
