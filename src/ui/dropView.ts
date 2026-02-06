import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import Ink2MDPlugin from '../main';
import type { SourceConfig } from '../types';

export const VIEW_TYPE_INK2MD_DROP = 'ink2md-drop-view';

export class Ink2MDDropView extends ItemView {
  private plugin: Ink2MDPlugin;
  private fileInput: HTMLInputElement | null = null;
  private selectedSourceId: string | null = null;
  private penIconEl: HTMLElement | null = null;
  private pendingSpinnerStop = false;
  private isImporting = false;
  private dropzoneTitleEl: HTMLElement | null = null;
  private dropzoneSubtitleEl: HTMLElement | null = null;
  private isMobile = false;
  private statusTimeout: number | null = null;
  private cancelRequested = false;

  constructor(leaf: WorkspaceLeaf, plugin: Ink2MDPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_INK2MD_DROP;
  }

	getDisplayText(): string {
		return `${this.plugin.getPluginName()} dropzone`;
	}

  getIcon(): string {
    return 'pen-tool';
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  refresh() {
    this.render();
  }

	private render() {
		const container = this.contentEl;
		container.empty();
		container.addClass('ink2md-drop-view-container');
		this.penIconEl = null;
		this.dropzoneTitleEl = null;
		this.dropzoneSubtitleEl = null;
		this.isMobile = (this.plugin.app as { isMobile?: boolean }).isMobile === true;

    const sources = this.plugin.getDropzoneSources();
		if (!sources.length) {
			const emptyState = container.createDiv({ cls: 'ink2md-drop-empty' });
			emptyState.createEl('h3', { text: 'Set up manual imports' });
			emptyState.createEl('p', {
				text: this.isMobile
					? 'Create a dropzone source in the plugin settings to use the file picker here.'
					: 'Create a dropzone source in the plugin settings to start dragging files here.',
			});
			return;
		}

    if (!this.selectedSourceId || !sources.find((source) => source.id === this.selectedSourceId)) {
      this.selectedSourceId = sources[0]!.id;
    }

    const wrapper = container.createDiv({ cls: 'ink2md-drop-view' });
	const header = wrapper.createDiv({ cls: 'ink2md-drop-header' });
	header.createEl('h3', { text: this.isMobile ? 'Select handwritten notes' : 'Drop handwritten notes' });
	header.createEl('p', {
		text: this.isMobile
			? 'Selected files are imported using your chosen source settings.'
			: 'Files you add here will be imported to the selected target.',
	});

    const sourceRow = wrapper.createDiv({ cls: 'ink2md-drop-row' });
    const label = sourceRow.createEl('label', { text: 'Target' });
    label.setAttr('for', 'ink2md-drop-source');
    const sourceSelect = sourceRow.createEl('select', { cls: 'ink2md-drop-select' });
    sourceSelect.id = 'ink2md-drop-source';
    for (const source of sources) {
      sourceSelect.createEl('option', { text: source.label, value: source.id });
    }
    sourceSelect.value = this.selectedSourceId ?? sources[0]!.id;
    sourceSelect.addEventListener('change', () => {
      this.selectedSourceId = sourceSelect.value;
      if (this.fileInput) {
        this.fileInput.accept = this.getAcceptForSource();
      }
    });

    const dropzone = wrapper.createDiv({ cls: 'ink2md-dropzone' });
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
      void this.handleDroppedFiles(Array.from(event.dataTransfer?.files ?? []));
    });
    dropzone.addEventListener('click', () => {
      if (this.isImporting) {
        if (this.plugin.requestCancelImport()) {
          this.setSpinner(false);
          this.cancelRequested = true;
          this.showDropzoneStatus('Cancelled', 'Import cancelled.', 2000);
        }
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
        if (!this.statusTimeout && !this.cancelRequested) {
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

	this.fileInput = wrapper.createEl('input', { type: 'file' });
	this.fileInput.addClass('ink2md-hidden-input');
    this.fileInput.multiple = true;
    this.fileInput.accept = this.getAcceptForSource();
	this.fileInput.addEventListener('change', () => {
		void this.handleDroppedFiles(Array.from(this.fileInput?.files ?? []));
		if (this.fileInput) {
			this.fileInput.value = '';
		}
	});

	this.updateDropzoneCopy(this.isImporting);
  }

  private getAcceptForSource(): string {
    const source = this.getSelectedSource();
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

  private getSelectedSource(): SourceConfig | null {
    const sources = this.plugin.getDropzoneSources();
    return sources.find((source) => source.id === this.selectedSourceId) ?? sources[0] ?? null;
  }

  private async handleDroppedFiles(files: File[]) {
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
      new Notice('Unable to read file paths from the dropped files.');
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
    this.showDropzoneStatus('Importing', this.isMobile ? 'Tap to cancel.' : 'Click to cancel.');
    this.setSpinner(true);
    try {
      await this.plugin.importDroppedFiles(source.id, paths, metadata);
      if (!this.cancelRequested) {
        this.showDropzoneStatus('Done', 'Import complete.', 2000);
      }
    } catch (error) {
      console.error('[ink2md] Failed to import dropped files', error);
      new Notice('Import failed. Check logs for details.');
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
        console.error('[ink2md] Unable to stage dropped file', error);
      }
    }
    return { entries, staged };
  }

  private setSpinner(active: boolean) {
    if (!this.penIconEl) {
      return;
    }
    if (active) {
      this.pendingSpinnerStop = false;
      this.isImporting = true;
      this.penIconEl.classList.add('is-spinning');
    } else {
      if (this.penIconEl.classList.contains('is-spinning')) {
        this.pendingSpinnerStop = true;
      } else {
        this.pendingSpinnerStop = false;
      }
      this.isImporting = false;
      if (!this.pendingSpinnerStop) {
        if (!this.statusTimeout && !this.cancelRequested) {
          this.updateDropzoneCopy(false);
        }
      }
    }
  }

  private updateDropzoneCopy(isImporting: boolean) {
    if (isImporting) {
      this.applyText(this.dropzoneTitleEl, 'Importing');
      this.applyText(this.dropzoneSubtitleEl, this.isMobile ? 'Tap to cancel.' : 'Click to cancel.');
      return;
    }
    const idleTitle = this.isMobile ? 'Tap to select files' : 'Drop files here';
    const idleSubtitle = this.isMobile ? 'Use the picker to browse or take photos.' : 'or click to browse for files';
    this.applyText(this.dropzoneTitleEl, idleTitle);
    this.applyText(this.dropzoneSubtitleEl, idleSubtitle);
  }

  private showDropzoneStatus(title: string, subtitle: string, timeoutMs?: number) {
    if (this.statusTimeout) {
      window.clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    this.applyText(this.dropzoneTitleEl, title);
    this.applyText(this.dropzoneSubtitleEl, subtitle);
    if (timeoutMs) {
      this.statusTimeout = window.setTimeout(() => {
        this.statusTimeout = null;
        if (!this.isImporting) {
          this.updateDropzoneCopy(false);
        }
      }, timeoutMs);
    }
  }

  private applyText(element: HTMLElement | null, text: string) {
    if (!element) {
      return;
    }
    element.textContent = text;
  }
}
