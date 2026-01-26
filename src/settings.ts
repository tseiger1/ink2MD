import { AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, SliderComponent, setIcon } from 'obsidian';
import Ink2MDPlugin from './main';
import { Ink2MDSettings, LLMGenerationMode, LLMProvider, LLMPreset, SourceConfig } from './types';

type PresetSecretState = {
  hasSecret: boolean;
  dirty: boolean;
  cleared: boolean;
};

const DEFAULT_PROMPT = `Convert handwritten notes to markdown. Treat all supplied pages as one note.

If a task has a due date, format it in the following pattern:
- [ ] Task text 📅 2026-01-21
If a task has an exclamation mark, make it high priority:
- [!] Task text ...
If there is a star symbol, convert it to a #star tag.
If text is highlighted, make it bold.
If there is a drawn flow convert it to mermaid.
If there is just a drawing, ignore it.
Convert tables to markdown tables.

Return plain markdown without any additional text or annotations.`;

const DEFAULT_PRESET_ID = 'preset-default';
const DEFAULT_SOURCE_ID = 'source-default';
const DEFAULT_OUTPUT_ROOT = 'Ink2MD';
const DEFAULT_SOURCE_LABEL = 'Source';

const DEFAULT_LLM_PRESET: LLMPreset = {
  id: DEFAULT_PRESET_ID,
  label: 'Default preset',
  provider: 'openai',
  generationMode: 'batch',
  llmMaxWidth: 512,
  openAI: {
    apiKey: '',
    model: 'gpt-5.2',
    promptTemplate: DEFAULT_PROMPT,
    imageDetail: 'low',
  },
  local: {
    endpoint: 'http://localhost:11434/v1/chat/completions',
    apiKey: '',
    model: 'llama-vision',
    promptTemplate: DEFAULT_PROMPT,
    imageDetail: 'low',
  },
};

const DEFAULT_SOURCE: SourceConfig = {
  id: DEFAULT_SOURCE_ID,
  label: DEFAULT_SOURCE_LABEL,
  type: 'filesystem',
  directories: [],
  recursive: true,
  includeImages: true,
  includePdfs: true,
  includeSupernote: true,
  attachmentMaxWidth: 0,
  pdfDpi: 300,
  replaceExisting: false,
  outputFolder: `${DEFAULT_OUTPUT_ROOT}/${DEFAULT_SOURCE_LABEL}`,
  openGeneratedNotes: false,
  openInNewLeaf: true,
  llmPresetId: DEFAULT_PRESET_ID,
};

export const DEFAULT_SETTINGS: Ink2MDSettings = {
  sources: [DEFAULT_SOURCE],
  llmPresets: [DEFAULT_LLM_PRESET],
  processedSources: {},
  secretBindings: {},
};

export class Ink2MDSettingTab extends PluginSettingTab {
  plugin: Ink2MDPlugin;
  private expandedSources = new Set<string>();
  private expandedPresets = new Set<string>();
  private sourceDrafts = new Map<string, SourceConfig>();
  private presetDrafts = new Map<string, LLMPreset>();
  private presetSecretStates = new Map<string, PresetSecretState>();

  constructor(app: App, plugin: Ink2MDPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const hero = containerEl.createDiv({ cls: 'ink2md-hero' });
    const icon = hero.createSpan({ cls: 'ink2md-hero-icon' });
    setIcon(icon, 'pen-tool' as any);
    const heroText = hero.createDiv({ cls: 'ink2md-hero-text' });
    heroText.createEl('h2', { text: 'Ink2MD' });
    heroText.createEl('p', {
      text: 'Import handwritten notes, convert them to markdown, and summarize them with a vision LLM.',
    });
    this.renderSourcesSection(containerEl);
    this.renderPresetsSection(containerEl);
  }

  private renderSourcesSection(containerEl: HTMLElement) {
    const { sectionEl, actions } = this.createSection(
      containerEl,
      'Sources',
      'Define input sources to watch.',
    );

    this.createTextButton(actions, 'Clear all caches', async () => {
      if (!(await this.confirmReset())) {
        return;
      }
      this.plugin.settings.processedSources = {};
      await this.plugin.saveSettings();
      new Notice('Ink2MD: cleared cache for every source.');
    }, !this.hasAnyCache());
    this.createTextButton(actions, '+ Add source', () => {
      const preset = this.plugin.settings.llmPresets[0];
      if (!preset) {
        new Notice('Create a preset before adding sources.');
        return;
      }
      const label = `Source ${this.plugin.settings.sources.length + 1}`;
      const newSource: SourceConfig = {
        ...this.cloneSource(DEFAULT_SOURCE),
        id: this.createId('source'),
        label,
        outputFolder: this.getDefaultOutputFolder(label),
        llmPresetId: preset.id,
      };
      this.plugin.settings.sources.unshift(newSource);
      this.expandedSources.add(newSource.id);
      this.sourceDrafts.set(newSource.id, this.cloneSource(newSource));
      void this.plugin.saveSettings();
      this.display();
    });

    const list = sectionEl.createDiv({ cls: 'ink2md-card-list' });
    for (const source of this.plugin.settings.sources) {
      this.renderSourceCard(list, source);
    }
  }

  private renderSourceCard(containerEl: HTMLElement, source: SourceConfig) {
    const card = containerEl.createDiv({ cls: 'ink2md-card' });
    const header = card.createDiv({ cls: 'ink2md-card-header' });
    const titleEl = header.createEl('strong', { text: source.label });
    const summaryEl = header.createEl('span', { text: this.describeSource(source) });
    summaryEl.addClass('ink2md-card-summary');
    const actions = header.createDiv({ cls: 'ink2md-card-actions' });
    const expanded = this.expandedSources.has(source.id);
    this.createTextButton(actions, 'Clear cache', () => this.confirmClearSourceCache(source.id), !this.hasSourceCache(source.id));
    if (expanded) {
      this.createIconButton(actions, 'save', 'Save changes', () => this.saveSourceDraft(source.id));
      this.createIconButton(actions, 'x', 'Cancel changes', () => this.cancelSourceDraft(source.id));
    } else {
      this.createIconButton(actions, 'pencil', 'Edit source', () => this.expandSource(source.id));
    }
    this.createIconButton(actions, 'trash', 'Delete source', () => this.confirmDeleteSource(source.id), true);

    const body = card.createDiv({ cls: 'ink2md-card-body' });
    body.style.display = expanded ? '' : 'none';
    if (!expanded) {
      return;
    }
    const draft = this.getSourceDraft(source.id, source);
    this.renderSourceDetails(body, draft, titleEl, summaryEl);
  }

  private renderPresetsSection(containerEl: HTMLElement) {
    const { sectionEl, actions } = this.createSection(
      containerEl,
      'LLM presets',
      'Presets hold LLM settings and prompts.',
    );

    actions.createEl('button', { text: '+ Add preset', cls: 'ink2md-text-button' }).addEventListener('click', () => {
      const newPreset: LLMPreset = {
        ...this.clonePreset(DEFAULT_LLM_PRESET),
        id: this.createId('preset'),
        label: `Preset ${this.plugin.settings.llmPresets.length + 1}`,
      };
      this.plugin.settings.llmPresets.unshift(newPreset);
      this.expandedPresets.add(newPreset.id);
      this.presetDrafts.set(newPreset.id, this.clonePreset(newPreset));
      this.presetSecretStates.set(newPreset.id, { hasSecret: false, dirty: false, cleared: false });
      void this.plugin.saveSettings();
      this.display();
    });

    const list = sectionEl.createDiv({ cls: 'ink2md-card-list' });
    for (const preset of this.plugin.settings.llmPresets) {
      this.renderPresetCard(list, preset);
    }
  }

  private renderPresetCard(containerEl: HTMLElement, preset: LLMPreset) {
    const card = containerEl.createDiv({ cls: 'ink2md-card' });
    const header = card.createDiv({ cls: 'ink2md-card-header' });
    const titleEl = header.createEl('strong', { text: preset.label });
    const summaryEl = header.createEl('span', { text: this.describePreset(preset) });
    summaryEl.addClass('ink2md-card-summary');
    const actions = header.createDiv({ cls: 'ink2md-card-actions' });
    const expanded = this.expandedPresets.has(preset.id);

    if (expanded) {
      this.createIconButton(actions, 'save', 'Save preset', () => this.savePresetDraft(preset.id));
      this.createIconButton(actions, 'x', 'Cancel edits', () => this.cancelPresetDraft(preset.id));
    } else {
      this.createIconButton(actions, 'pencil', 'Edit preset', () => this.expandPreset(preset.id));
    }
    this.createIconButton(actions, 'trash', 'Delete preset', () => this.confirmDeletePreset(preset.id), true);

    const body = card.createDiv({ cls: 'ink2md-card-body' });
    body.style.display = expanded ? '' : 'none';
    if (!expanded) {
      return;
    }
    const draft = this.getPresetDraft(preset.id, preset);
    this.renderPresetDetails(body, draft, titleEl, summaryEl);
  }

  private renderSourceDetails(container: HTMLElement, draft: SourceConfig, titleEl: HTMLElement, summaryEl: HTMLElement) {
    new Setting(container)
      .setName('Label')
      .setDesc('Shown in the source list.')
      .addText((text) =>
        text
          .setValue(draft.label)
          .onChange((value) => {
            draft.label = value.trim() || draft.label;
            titleEl.setText(draft.label);
          }),
      );

    const directoriesSetting = new Setting(container)
      .setName('Directories')
      .setDesc('Absolute paths, one per line. Sub-folders are included when recursive is enabled.');
    directoriesSetting.controlEl.empty();
    const directoriesInput = directoriesSetting.controlEl.createEl('textarea', {
      cls: 'ink2md-source-directories',
      text: draft.directories.join('\n'),
    });
    directoriesInput.rows = 4;
    directoriesInput.addEventListener('change', () => {
      draft.directories = directoriesInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      summaryEl.setText(this.describeSource(draft));
    });

    new Setting(container)
      .setName('Recursive scan')
      .setDesc('Include files inside sub-folders automatically.')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.recursive)
          .onChange((value) => {
            draft.recursive = value;
          }),
      );

    new Setting(container)
      .setName('Image imports (.png/.jpg/.webp)')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.includeImages)
          .onChange((value) => {
            draft.includeImages = value;
          }),
      );

    new Setting(container)
      .setName('PDF imports')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.includePdfs)
          .onChange((value) => {
            draft.includePdfs = value;
          }),
      );

    new Setting(container)
      .setName('Supernote imports (.note)')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.includeSupernote)
          .onChange((value) => {
            draft.includeSupernote = value;
          }),
      );

    new Setting(container)
      .setName('Output folder')
      .setDesc('Vault folder where converted notes are saved.')
      .addSearch((search) => {
        search
          .setPlaceholder(`${DEFAULT_OUTPUT_ROOT}/My source`)
          .setValue(draft.outputFolder)
          .onChange((value) => {
            draft.outputFolder = value.trim() || this.getDefaultOutputFolder(draft.label);
          });
        new FolderSuggest(this.app, search.inputEl);
      });

    new Setting(container)
      .setName('Replace existing imports')
      .setDesc('Overwrite previous runs instead of creating timestamped folders.')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.replaceExisting)
          .onChange((value) => {
            draft.replaceExisting = value;
          }),
      );

    this.renderSliderSetting({
      containerEl: container,
      name: 'Attachment PNG width',
      desc: 'Scale images saved to the vault. Set to 0 to keep originals.',
      min: 0,
      max: 4096,
      step: 64,
      value: draft.attachmentMaxWidth,
      formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
      onChange: (value) => {
        draft.attachmentMaxWidth = value;
      },
    });

    this.renderSliderSetting({
      containerEl: container,
      name: 'PDF rasterization DPI',
      desc: 'Higher values improve fidelity at the cost of larger files.',
      min: 72,
      max: 600,
      step: 12,
      value: draft.pdfDpi,
      formatValue: (value) => `${value} DPI`,
      onChange: (value) => {
        draft.pdfDpi = value;
      },
    });

    new Setting(container)
      .setName('Open generated notes')
      .setDesc('Choose where converted notes open after each import.')
      .addDropdown((dropdown) => {
        const currentValue = draft.openGeneratedNotes ? (draft.openInNewLeaf ? 'new' : 'current') : 'none';
        dropdown
          .addOption('none', 'Do not open automatically')
          .addOption('current', 'Open in current tab')
          .addOption('new', 'Open in new tab')
          .setValue(currentValue)
          .onChange((value) => {
            if (value === 'none') {
              draft.openGeneratedNotes = false;
              draft.openInNewLeaf = false;
              return;
            }
            draft.openGeneratedNotes = true;
            draft.openInNewLeaf = value === 'new';
          });
      });

    new Setting(container)
      .setName('LLM preset')
      .setDesc('Pick which preset powers this source.')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(Object.fromEntries(this.plugin.settings.llmPresets.map((preset) => [preset.id, preset.label])))
          .setValue(draft.llmPresetId ?? this.plugin.settings.llmPresets[0]?.id ?? DEFAULT_PRESET_ID)
          .onChange((value) => {
            draft.llmPresetId = value;
            summaryEl.setText(this.describeSource(draft));
          });
      });
  }

  private renderPresetDetails(container: HTMLElement, draft: LLMPreset, titleEl: HTMLElement, summaryEl: HTMLElement) {
    new Setting(container)
      .setName('Label')
      .setDesc('Shown in the source dropdown.')
      .addText((text) =>
        text
          .setValue(draft.label)
          .onChange((value) => {
            draft.label = value.trim() || draft.label;
            titleEl.setText(draft.label);
          }),
      );

    new Setting(container)
      .setName('Provider')
      .setDesc('Choose between OpenAI and a local OpenAI-compatible endpoint.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('openai', 'OpenAI')
          .addOption('local', 'Local')
          .setValue(draft.provider)
          .onChange((value) => {
            draft.provider = value as LLMProvider;
            summaryEl.setText(this.describePreset(draft));
            this.display();
          }),
      );

    new Setting(container)
      .setName('Generation mode')
      .setDesc('Streaming writes tokens to disk live; batch waits for completion.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('batch', 'Batch')
          .addOption('stream', 'Streaming')
          .setValue(draft.generationMode)
          .onChange((value) => {
            draft.generationMode = value as LLMGenerationMode;
            summaryEl.setText(this.describePreset(draft));
          }),
      );

    this.renderSliderSetting({
      containerEl: container,
      name: 'LLM image width',
      desc: 'Downscale pages sent to the LLM. Set to 0 to keep originals.',
      min: 0,
      max: 2048,
      step: 32,
      value: draft.llmMaxWidth,
      formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
      onChange: (value) => {
        draft.llmMaxWidth = value;
      },
    });

    const providerFields = container.createDiv({ cls: 'ink2md-provider-fields' });
    if (draft.provider === 'openai') {
      this.renderOpenAIFields(providerFields, draft, this.getPresetSecretState(draft.id));
    } else {
      this.renderLocalFields(providerFields, draft);
    }
  }

  private renderOpenAIFields(container: HTMLElement, draft: LLMPreset, secretState: PresetSecretState) {
    const apiKeySetting = new Setting(container).setName('API key');
    apiKeySetting.setDesc('');
    const descEl = apiKeySetting.descEl;
    descEl.empty();
    descEl.createSpan({ text: 'OpenAI API key used for this preset.' });
    for (const line of this.describeSecretStorageLines(draft.id)) {
      descEl.createEl('br');
      descEl.createSpan({ text: line });
    }
    apiKeySetting.addText((text) => {
        const placeholder = '••••••••';
        const canShowPlaceholder = secretState.hasSecret && !secretState.cleared && !secretState.dirty && !draft.openAI.apiKey;
        let showingPlaceholder = false;
        text.setPlaceholder('sk-...');
        if (canShowPlaceholder) {
          text.setValue(placeholder);
          showingPlaceholder = true;
        } else {
          text.setValue(draft.openAI.apiKey);
        }
        text.onChange((value) => {
          if (showingPlaceholder) {
            return;
          }
          const trimmed = value.trim();
          draft.openAI.apiKey = trimmed;
          secretState.dirty = true;
          secretState.cleared = trimmed.length === 0;
        });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.inputEl.addEventListener('focus', () => {
          if (showingPlaceholder) {
            showingPlaceholder = false;
            text.setValue('');
          }
        });
        text.inputEl.addEventListener('blur', () => {
          if (!secretState.dirty && secretState.hasSecret && !secretState.cleared && !text.inputEl.value) {
            showingPlaceholder = true;
            text.setValue(placeholder);
          }
        });
      });

    new Setting(container)
      .setName('Model')
      .addText((text) =>
        text
          .setValue(draft.openAI.model)
          .onChange((value) => {
            draft.openAI.model = value.trim();
          }),
      );

    new Setting(container)
      .setName('Image detail')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('low', 'Low')
          .addOption('high', 'High')
          .setValue(draft.openAI.imageDetail)
          .onChange((value) => {
            draft.openAI.imageDetail = value === 'high' ? 'high' : 'low';
          }),
      );

    this.renderPromptTextarea(container, draft.openAI.promptTemplate, (value) => {
      draft.openAI.promptTemplate = value;
    });
  }

  private renderLocalFields(container: HTMLElement, draft: LLMPreset) {
    new Setting(container)
      .setName('Endpoint URL')
      .setDesc('HTTP endpoint that accepts OpenAI-compatible chat completions requests.')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:11434/v1/chat/completions')
          .setValue(draft.local.endpoint)
          .onChange((value) => {
            draft.local.endpoint = value.trim();
          }),
      );

    new Setting(container)
      .setName('API key (optional)')
      .addText((text) =>
        text
          .setValue(draft.local.apiKey)
          .onChange((value) => {
            draft.local.apiKey = value.trim();
          }),
      );

    new Setting(container)
      .setName('Model name')
      .addText((text) =>
        text
          .setValue(draft.local.model)
          .onChange((value) => {
            draft.local.model = value.trim();
          }),
      );

    new Setting(container)
      .setName('Image detail')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('low', 'Low')
          .addOption('high', 'High')
          .setValue(draft.local.imageDetail)
          .onChange((value) => {
            draft.local.imageDetail = value === 'high' ? 'high' : 'low';
          }),
      );

    this.renderPromptTextarea(container, draft.local.promptTemplate, (value) => {
      draft.local.promptTemplate = value;
    });
  }

  private createSection(containerEl: HTMLElement, title: string, description: string) {
    const sectionEl = containerEl.createDiv({ cls: 'ink2md-settings-section' });
    const header = sectionEl.createDiv({ cls: 'ink2md-section-header' });
    const info = header.createDiv({ cls: 'ink2md-section-info' });
    info.createEl('h3', { text: title });
    info.createEl('p', { text: description });
    const actions = header.createDiv({ cls: 'ink2md-header-actions' });
    return { sectionEl, actions };
  }

  private describeSource(source: SourceConfig): string {
    const parts = [];
    const dirCount = source.directories.length;
    if (dirCount === 0) {
      parts.push('No folders');
    } else if (dirCount === 1) {
      parts.push('1 folder');
    } else {
      parts.push(`${dirCount} folders`);
    }
    const preset = this.plugin.settings.llmPresets.find((entry) => entry.id === source.llmPresetId);
    if (preset) {
      parts.push(`Preset: ${preset.label}`);
    }
    return parts.join(' • ');
  }

  private describePreset(preset: LLMPreset): string {
    return `Provider: ${preset.provider === 'openai' ? 'OpenAI' : 'Local'} • Mode: ${preset.generationMode === 'stream' ? 'Streaming' : 'Batch'}`;
  }

  private getDefaultOutputFolder(label: string) {
    const trimmed = label?.trim() || 'Source';
    return `${DEFAULT_OUTPUT_ROOT}/${trimmed}`;
  }

  private getSourceDraft(id: string, source: SourceConfig): SourceConfig {
    if (!this.sourceDrafts.has(id)) {
      this.sourceDrafts.set(id, this.cloneSource(source));
    }
    return this.sourceDrafts.get(id)!;
  }

  private getPresetDraft(id: string, preset: LLMPreset): LLMPreset {
    if (!this.presetDrafts.has(id)) {
      this.presetDrafts.set(id, this.clonePreset(preset));
    }
    return this.presetDrafts.get(id)!;
  }

  private getPresetSecretState(id: string): PresetSecretState {
    if (!this.presetSecretStates.has(id)) {
      this.presetSecretStates.set(id, {
        hasSecret: this.plugin.hasOpenAISecret(id),
        dirty: false,
        cleared: false,
      });
    }
    return this.presetSecretStates.get(id)!;
  }

  private async clearSourceCache(sourceId: string) {
    const store = this.plugin.settings.processedSources;
    let removed = 0;
    for (const key of Object.keys(store)) {
      if (store[key]?.sourceId === sourceId) {
        delete store[key];
        removed += 1;
      }
    }
    await this.plugin.saveSettings();
    if (removed > 0) {
      new Notice(`Ink2MD: cleared ${removed} cached entries.`);
    }
  }

  private async confirmDeleteSource(sourceId: string) {
    const confirmed = await this.confirmAction({
      title: "Delete source?",
      message: "This removes the source configuration.",
      confirmLabel: "Delete",
      confirmWarning: true,
    });
    if (!confirmed) {
      return;
    }
    await this.deleteSource(sourceId);
  }

  private hasSourceCache(sourceId: string): boolean {
    return Object.values(this.plugin.settings.processedSources).some((entry) => entry?.sourceId === sourceId);
  }

  private hasAnyCache(): boolean {
    return Object.keys(this.plugin.settings.processedSources).length > 0;
  }

  private async deleteSource(sourceId: string) {
    if (this.plugin.settings.sources.length === 1) {
      new Notice('Ink2MD: at least one source is required.');
      return;
    }
    this.plugin.settings.sources = this.plugin.settings.sources.filter((source) => source.id !== sourceId);
    this.sourceDrafts.delete(sourceId);
    await this.clearSourceCache(sourceId);
    await this.plugin.saveSettings();
    new Notice('Ink2MD: source deleted.');
    this.display();
  }

  private async confirmDeletePreset(presetId: string) {
    const confirmed = await this.confirmAction({
      title: "Delete preset?",
      message: "This preset will be removed.",
      confirmLabel: "Delete",
      confirmWarning: true,
    });
    if (!confirmed) {
      return;
    }
    await this.deletePreset(presetId);
  }

  private async deletePreset(presetId: string) {
    const inUse = this.plugin.settings.sources.some((source) => source.llmPresetId === presetId);
    if (inUse) {
      new Notice('Ink2MD: this preset is still referenced by at least one source.');
      return;
    }
    if (this.plugin.settings.llmPresets.length === 1) {
      new Notice('Ink2MD: at least one preset is required.');
      return;
    }
    this.plugin.settings.llmPresets = this.plugin.settings.llmPresets.filter((preset) => preset.id !== presetId);
    this.presetDrafts.delete(presetId);
    this.presetSecretStates.delete(presetId);
    await this.plugin.deleteOpenAISecret(presetId);
    await this.plugin.saveSettings();
    this.display();
  }

  private async saveSourceDraft(sourceId: string) {
    const draft = this.sourceDrafts.get(sourceId);
    if (!draft) {
      this.collapseSource(sourceId);
      return;
    }
    const index = this.plugin.settings.sources.findIndex((entry) => entry.id === sourceId);
    if (index >= 0) {
      this.plugin.settings.sources[index] = this.cloneSource(draft);
    }
    this.sourceDrafts.delete(sourceId);
    await this.plugin.saveSettings();
    this.collapseSource(sourceId);
  }

  private cancelSourceDraft(sourceId: string) {
    this.sourceDrafts.delete(sourceId);
    this.collapseSource(sourceId);
  }

  private async savePresetDraft(presetId: string) {
    const draft = this.presetDrafts.get(presetId);
    if (!draft) {
      this.collapsePreset(presetId);
      return;
    }
    const index = this.plugin.settings.llmPresets.findIndex((entry) => entry.id === presetId);
    if (index >= 0) {
      const secretState = this.getPresetSecretState(presetId);
      const clone = this.clonePreset(draft);
      const supportsSecretStorage = this.plugin.supportsSecretStorage();
      if (clone.provider === 'openai') {
        const input = draft.openAI.apiKey?.trim() ?? '';
        const shouldUpdateSecret = secretState.dirty && !secretState.cleared && input.length > 0;
        const shouldClearSecret = secretState.dirty && secretState.cleared;
        if (shouldUpdateSecret) {
          await this.plugin.setOpenAISecret(clone.id, input);
        } else if (shouldClearSecret) {
          await this.plugin.setOpenAISecret(clone.id, '');
        }
        clone.openAI.apiKey = supportsSecretStorage ? '' : input;
      } else {
        await this.plugin.deleteOpenAISecret(clone.id);
        clone.openAI.apiKey = '';
      }
      this.plugin.settings.llmPresets[index] = clone;
    }
    this.presetDrafts.delete(presetId);
    await this.plugin.saveSettings();
    this.collapsePreset(presetId);
  }

  private cancelPresetDraft(presetId: string) {
    this.presetDrafts.delete(presetId);
    this.collapsePreset(presetId);
  }

  private expandSource(id: string) {
    this.expandedSources.add(id);
    this.display();
  }

  private collapseSource(id: string) {
    this.expandedSources.delete(id);
    this.sourceDrafts.delete(id);
    this.display();
  }

  private expandPreset(id: string) {
    this.expandedPresets.add(id);
    this.display();
  }

  private collapsePreset(id: string) {
    this.expandedPresets.delete(id);
    this.presetDrafts.delete(id);
    this.presetSecretStates.delete(id);
    this.display();
  }

  private createIconButton(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void | Promise<void>,
    isDanger = false,
  ) {
    const button = container.createEl('button', { cls: 'ink2md-icon-button' });
    button.setAttr('aria-label', label);
    button.setAttr('title', label);
    if (isDanger) {
      button.addClass('mod-warning');
    }
    const iconSpan = button.createSpan();
    setIcon(iconSpan, icon as any);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(onClick()).catch((error) => console.error('[ink2md] Settings action failed', error));
    });
    return button;
  }

  private createTextButton(
    container: HTMLElement,
    label: string,
    onClick: () => void | Promise<void>,
    disabled = false,
  ) {
    const button = container.createEl('button', { cls: 'ink2md-text-button', text: label });
    button.setAttr('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', (event) => {
      if (button.disabled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(onClick()).catch((error) => console.error('[ink2md] Settings action failed', error));
    });
    return button;
  }

  private renderPromptTextarea(container: HTMLElement, value: string, onChange: (value: string) => void) {
    const setting = new Setting(container)
      .setName('Prompt')
      .setDesc('Prompt used for conversion. Keep it concise to reduce latency.');
    setting.settingEl.addClass('ink2md-prompt-setting');
    setting.controlEl.empty();
    setting.controlEl.addClass('ink2md-prompt-control');
    const textArea = setting.controlEl.createEl('textarea', {
      cls: 'ink2md-prompt-input',
      text: value,
    });
    textArea.rows = 8;
    textArea.addEventListener('input', () => {
      onChange(textArea.value);
    });
  }

  private renderSliderSetting(options: {
    containerEl: HTMLElement;
    name: string;
    desc: string;
    min: number;
    max: number;
    step: number;
    value: number;
    formatValue: (value: number) => string;
    onChange: (value: number) => void;
  }) {
    const setting = new Setting(options.containerEl)
      .setName(options.name)
      .setDesc(options.desc);

    let valueEl: HTMLSpanElement | null = null;
    const slider = new SliderComponent(setting.controlEl)
      .setLimits(options.min, options.max, options.step)
      .setDynamicTooltip()
      .setValue(options.value)
      .onChange((value) => {
        options.onChange(value);
        valueEl?.setText(options.formatValue(value));
      });

    valueEl = setting.controlEl.createSpan({
      cls: 'ink2md-slider-value',
      text: options.formatValue(options.value),
    });
    slider.sliderEl.insertAdjacentElement('afterend', valueEl);
  }

  private describeSecretStorageLines(presetId: string): string[] {
    if (!this.plugin.supportsSecretStorage()) {
      return ["Stored with plugin settings because Obsidian's keychain isn't available in this Obsidian build."];
    }
    const secretId = this.plugin.getPresetSecretId(presetId);
    if (secretId) {
      return ["Stored securely in Obsidian's keychain.", `ID: ${secretId}`];
    }
    return ["Stored securely in Obsidian's keychain."];
  }

  private async confirmAction(options: { title: string; message: string; confirmLabel: string; confirmWarning?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new (class extends Modal {
        constructor(app: App, private readonly onConfirm: (result: boolean) => void) {
          super(app);
        }

        onOpen() {
          const { contentEl } = this;
          contentEl.createEl('h3', { text: options.title });
          contentEl.createEl('p', { text: options.message });
          const buttonBar = contentEl.createDiv({ cls: 'ink2md-modal-buttons' });
          buttonBar.createEl('button', { text: 'Cancel' }).addEventListener('click', () => {
            this.close();
            this.onConfirm(false);
          });
          const confirm = buttonBar.createEl('button', { text: options.confirmLabel });
          if (options.confirmWarning) {
            confirm.addClass('mod-warning');
          }
          confirm.addEventListener('click', () => {
            this.close();
            this.onConfirm(true);
          });
        }

        onClose() {
          this.contentEl.empty();
        }
      })(this.app, resolve);
      modal.open();
    });
  }

  private async confirmClearSourceCache(sourceId: string) {
    const confirmed = await this.confirmAction({
      title: 'Clear cache for this source?',
      message: 'This clears the cache of already imported files. All files for this source will be reprocessed during the next import.',
      confirmLabel: 'Clear cache',
      confirmWarning: true,
    });
    if (!confirmed) {
      return;
    }
    await this.clearSourceCache(sourceId);
    this.display();
  }

  private async confirmReset(): Promise<boolean> {
    return this.confirmAction({
      title: 'Clear all caches?',
      message: 'This clears the cache of already imported files. All sources will reprocess every file during the next import.',
      confirmLabel: 'Clear all caches',
      confirmWarning: true,
    });
  }

  

  private createId(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private cloneSource(source: SourceConfig): SourceConfig {
    return JSON.parse(JSON.stringify(source));
  }

  private clonePreset(preset: LLMPreset): LLMPreset {
    return JSON.parse(JSON.stringify(preset));
  }
}

class FolderSuggest extends AbstractInputSuggest<string> {
  private folders: string[] = [];
  private readonly inputElRef: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputElRef = inputEl;
    this.refresh();
  }

  getSuggestions(inputStr: string): string[] {
    const query = inputStr.trim().toLowerCase();
    this.refresh();
    return this.folders.filter((folder) => folder.toLowerCase().includes(query));
  }

  renderSuggestion(folder: string, el: HTMLElement) {
    el.addClass('ink2md-folder-suggestion');
    el.setText(folder || '/');
  }

  selectSuggestion(folder: string) {
    this.inputElRef.value = folder;
    this.inputElRef.dispatchEvent(new Event('input'));
    this.close();
  }

  private refresh() {
    const dedup = new Set<string>();
    const folders = this.app.vault.getAllFolders();
    for (const folder of folders) {
      if (folder.path && folder.path !== '/') {
        dedup.add(folder.path);
      }
    }
    const sorted = Array.from(dedup).sort((a, b) => a.localeCompare(b));
    this.folders = ['/', ...sorted];
  }
}
