import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import Ink2MDPlugin from '../main';
import type { SourceConfig } from '../types';

export const VIEW_TYPE_INK2MD_DROP = 'ink2md-drop-view';

export class Ink2MDDropView extends ItemView {
  private plugin: Ink2MDPlugin;
  private fileInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private selectedSourceId: string | null = null;

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
    this.containerEl.empty();
  }

  refresh() {
    this.render();
  }

  private render() {
    const container = this.containerEl;
    container.empty();
    container.addClass('ink2md-drop-view-container');

    const sources = this.plugin.getDropzoneSources();
		if (!sources.length) {
			const emptyState = container.createDiv({ cls: 'ink2md-drop-empty' });
			emptyState.createEl('h3', { text: 'Set up manual imports' });
			emptyState.createEl('p', {
				text: 'Create a dropzone source in the plugin settings to start dragging files here.',
			});
			return;
		}

    if (!this.selectedSourceId || !sources.find((source) => source.id === this.selectedSourceId)) {
      this.selectedSourceId = sources[0]!.id;
    }

    const wrapper = container.createDiv({ cls: 'ink2md-drop-view' });
    const header = wrapper.createDiv({ cls: 'ink2md-drop-header' });
    header.createEl('h3', { text: 'Drop handwritten notes' });
    header.createEl('p', {
      text: 'Dropped files are imported using your selected source settings.',
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
      this.fileInput?.click();
    });

    const iconWrapper = dropzone.createDiv({ cls: 'ink2md-dropzone-icon-wrapper' });
    const docIcon = iconWrapper.createDiv({ cls: 'ink2md-dropzone-doc-icon' });
    setIcon(docIcon, 'file');
    const penIcon = iconWrapper.createDiv({ cls: 'ink2md-dropzone-pen-icon' });
    setIcon(penIcon, 'pen-tool');

    dropzone.createDiv({ cls: 'ink2md-dropzone-title', text: 'Drop files here' });
    dropzone.createDiv({
      cls: 'ink2md-dropzone-subtitle',
      text: 'or click to browse for files',
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

    this.statusEl = wrapper.createDiv({ cls: 'ink2md-drop-status', text: 'Waiting for files...' });
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
    this.setStatus(`Importing ${paths.length} file${paths.length === 1 ? '' : 's'}...`);
    try {
      await this.plugin.importDroppedFiles(source.id, paths, metadata);
      this.setStatus('Files queued for import.');
    } catch (error) {
      console.error('[ink2md] Failed to import dropped files', error);
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
        console.error('[ink2md] Unable to stage dropped file', error);
      }
    }
    return { entries, staged };
  }

  private setStatus(message: string) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
}
