import { Modal, Notice, setIcon } from 'obsidian';
import type Ink2MDPlugin from '../main';
import type { SourceConfig } from '../types';

export class PickerModal extends Modal {
	private fileInput: HTMLInputElement | null = null;
	private sourceSelect: HTMLSelectElement | null = null;
	private penIconEl: HTMLElement | null = null;
	private dropzoneTitleEl: HTMLElement | null = null;
	private dropzoneSubtitleEl: HTMLElement | null = null;
	private pendingSpinnerStop = false;
	private statusTimeout: number | null = null;
	private cancelRequested = false;
	private isMobile = false;

	constructor(private readonly plugin: Ink2MDPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ink2md-mobile-picker');
		this.isMobile = (this.plugin.app as { isMobile?: boolean }).isMobile === true;

		const sources = this.plugin.getDropzoneSources();
		if (!sources.length) {
			contentEl.createEl('p', {
				text: 'Create a dropzone source in settings to import files from the picker.',
			});
			return;
		}

		contentEl.createEl('h3', {
			text: this.isMobile ? 'Select handwritten notes' : 'Drop handwritten notes',
		});
		contentEl.createEl('p', {
			text: this.isMobile
				? 'Selected files are imported using your chosen source settings.'
				: 'Files you add here will be imported to the selected target.',
		});

		const sourceLabel = contentEl.createEl('label', { text: 'Target' });
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

		const dropzone = contentEl.createDiv({ cls: 'ink2md-dropzone' });
		if (!this.isMobile) {
			dropzone.addEventListener('dragover', (event) => {
				event.preventDefault();
				dropzone.classList.add('is-dragging');
			});
			dropzone.addEventListener('dragleave', () => {
				dropzone.classList.remove('is-dragging');
			});
			dropzone.addEventListener('drop', (event) => {
				event.preventDefault();
				dropzone.classList.remove('is-dragging');
				void this.handleSelectedFiles(Array.from(event.dataTransfer?.files ?? []));
			});
		}
		dropzone.addEventListener('click', () => {
			if (this.plugin.requestCancelImport()) {
				this.setSpinner(false);
				this.cancelRequested = true;
				this.showDropzoneStatus('Cancelled', 'Import cancelled.', 2000);
				return;
			}
			this.fileInput?.click();
		});

		const iconWrapper = dropzone.createDiv({ cls: 'ink2md-dropzone-icon-wrapper' });
		const docIcon = iconWrapper.createDiv({ cls: 'ink2md-dropzone-doc-icon' });
		setIcon(docIcon, 'file');
		this.penIconEl = iconWrapper.createDiv({ cls: 'ink2md-dropzone-pen-icon' });
		setIcon(this.penIconEl, 'pen-tool');
		this.penIconEl.addEventListener('animationiteration', () => {
			if (this.pendingSpinnerStop) {
				this.penIconEl?.classList.remove('is-spinning');
				this.pendingSpinnerStop = false;
				if (!this.statusTimeout) {
					this.updateDropzoneCopy(false);
				}
			}
		});

		this.dropzoneTitleEl = dropzone.createDiv({
			cls: 'ink2md-dropzone-title',
			text: this.isMobile ? 'Tap to select files' : 'Drop files here',
		});
		this.dropzoneSubtitleEl = dropzone.createDiv({
			cls: 'ink2md-dropzone-subtitle',
			text: this.isMobile ? 'Use the picker to browse or take photos.' : 'or click to browse for files',
		});

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

		this.updateDropzoneCopy(false);
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
			new Notice('No files selected.');
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
		this.cancelRequested = false;
		this.showDropzoneStatus('Importing', 'Tap to cancel.');
		this.setSpinner(true);
		try {
			await this.plugin.importDroppedFiles(source.id, paths, metadata);
			if (!this.cancelRequested) {
				this.showDropzoneStatus('Done', 'Import complete.', 2000);
				this.maybeScheduleAutoClose();
			}
		} catch (error) {
			console.error('[ink2md] Failed to import selected files', error);
			if (!this.cancelRequested) {
				this.showDropzoneStatus('Import failed', 'Check logs for details.', 2000);
			}
		} finally {
			this.setSpinner(false);
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

	private setSpinner(active: boolean): void {
		if (!this.penIconEl) {
			return;
		}
		if (active) {
			this.pendingSpinnerStop = false;
			this.penIconEl.classList.add('is-spinning');
			return;
		}
		if (this.penIconEl.classList.contains('is-spinning')) {
			this.pendingSpinnerStop = true;
		} else {
			this.pendingSpinnerStop = false;
		}
		if (!this.pendingSpinnerStop && !this.statusTimeout) {
			this.updateDropzoneCopy(false);
		}
	}

	private updateDropzoneCopy(isImporting: boolean): void {
		if (isImporting) {
			this.applyText(this.dropzoneTitleEl, 'Importing');
			this.applyText(this.dropzoneSubtitleEl, this.isMobile ? 'Tap to cancel.' : 'Click to cancel.');
			return;
		}
		this.applyText(this.dropzoneTitleEl, this.isMobile ? 'Tap to select files' : 'Drop files here');
		this.applyText(this.dropzoneSubtitleEl, this.isMobile ? 'Use the picker to browse or take photos.' : 'or click to browse for files');
	}

	private showDropzoneStatus(title: string, subtitle: string, timeoutMs?: number): void {
		if (this.statusTimeout) {
			window.clearTimeout(this.statusTimeout);
			this.statusTimeout = null;
		}
		this.applyText(this.dropzoneTitleEl, title);
		this.applyText(this.dropzoneSubtitleEl, subtitle);
		if (timeoutMs) {
			this.statusTimeout = window.setTimeout(() => {
				this.statusTimeout = null;
				this.updateDropzoneCopy(false);
			}, timeoutMs);
		}
	}

	private maybeScheduleAutoClose(): void {
		if (!this.plugin.settings.autoClosePickerModal) {
			return;
		}
		window.setTimeout(() => {
			this.close();
		}, 2000);
	}

	private applyText(element: HTMLElement | null, text: string): void {
		if (!element) {
			return;
		}
		element.textContent = text;
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
