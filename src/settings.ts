import { AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, SliderComponent, TextComponent, setIcon } from 'obsidian';
import Ink2MDPlugin from './main';
import { Ink2MDSettings, LLMProvider, LLMPreset, SourceConfig, SourceType } from './types';

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
const DEFAULT_DROPZONE_ID = 'source-dropzone';
const DEFAULT_DROPZONE_LABEL = 'Dropzone Target';

const PROVIDER_LABELS: Record<LLMProvider, string> = {
	openai: 'OpenAI',
	'azure-openai': 'Azure OpenAI',
	gemini: 'Google Gemini',
	anthropic: 'Anthropic',
	local: 'Local',
};

const OPENAI_KEY_PLACEHOLDER = 'sk-...';
const AZURE_KEY_PLACEHOLDER = 'az-...';
const GEMINI_KEY_PLACEHOLDER = 'AIza...';
const ANTHROPIC_KEY_PLACEHOLDER = 'sk-ant-...';
const ANTHROPIC_BASE_URL_PLACEHOLDER = 'https://api.anthropic.com';
const ANTHROPIC_MODEL_PLACEHOLDER = 'claude-3-5-sonnet-20240620';
const LOCAL_ENDPOINT_PLACEHOLDER = 'http://localhost:11434/v1/chat/completions';
const AZURE_ENDPOINT_PLACEHOLDER = 'https://example-resource.openai.azure.com/';
const AZURE_MODEL_PLACEHOLDER = 'gpt-5-mini';
const AZURE_VERSION_PLACEHOLDER = '2024-02-15-preview';

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
  azureOpenAI: {
    apiKey: '',
    endpoint: 'https://example-resource.openai.azure.com/',
    deployment: 'gpt-5-mini',
    apiVersion: '2024-02-15-preview',
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
  anthropic: {
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20240620',
    promptTemplate: DEFAULT_PROMPT,
  },
  gemini: {
    apiKey: '',
    model: 'gemini-1.5-flash',
    promptTemplate: DEFAULT_PROMPT,
  },
};

const DEFAULT_SOURCE: SourceConfig = {
  id: DEFAULT_SOURCE_ID,
  label: `${DEFAULT_SOURCE_LABEL} 1`,
  type: 'filesystem',
  directories: [],
  recursive: true,
  includeImages: true,
  includePdfs: true,
  attachmentMaxWidth: 0,
  pdfDpi: 300,
  replaceExisting: false,
  outputFolder: `${DEFAULT_OUTPUT_ROOT}/${DEFAULT_SOURCE_LABEL} 1`,
  openGeneratedNotes: false,
  openInNewLeaf: true,
  llmPresetId: DEFAULT_PRESET_ID,
  preImportScript: '',
};

const DEFAULT_DROPZONE_SOURCE: SourceConfig = {
  id: DEFAULT_DROPZONE_ID,
  label: `${DEFAULT_DROPZONE_LABEL} 1`,
  type: 'dropzone',
  directories: [],
  recursive: false,
  includeImages: true,
  includePdfs: true,
  attachmentMaxWidth: 0,
  pdfDpi: 300,
  replaceExisting: false,
  outputFolder: `${DEFAULT_OUTPUT_ROOT}/${DEFAULT_DROPZONE_LABEL} 1`,
  openGeneratedNotes: false,
  openInNewLeaf: true,
  llmPresetId: DEFAULT_PRESET_ID,
  preImportScript: '',
};

export const DEFAULT_SETTINGS: Ink2MDSettings = {
  sources: [DEFAULT_SOURCE, DEFAULT_DROPZONE_SOURCE],
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
  private autoLabelStates = new Map<string, boolean>();

  constructor(app: App, plugin: Ink2MDPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
	const hero = containerEl.createDiv({ cls: 'ink2md-hero' });
	const icon = hero.createSpan({ cls: 'ink2md-hero-icon' });
	setIcon(icon, 'pen-tool');
	const heroText = hero.createDiv({ cls: 'ink2md-hero-text' });
	new Setting(heroText).setName(this.plugin.getPluginName()).setHeading();
	heroText.createEl('p', {
		text: 'Import handwritten notes, convert them to Markdown, and summarize them with a vision model.',
	});
    this.renderSourcesSection(containerEl);
    this.renderPresetsSection(containerEl);
  }

  private renderSourcesSection(containerEl: HTMLElement) {
	const { sectionEl, actions } = this.createSection(
		containerEl,
		'Sources & targets',
		'Define folder sources or dropzone targets for manual imports.',
	);

    this.createTextButton(actions, 'Clear all caches', async () => {
      if (!(await this.confirmReset())) {
        return;
      }
      this.plugin.settings.processedSources = {};
      await this.plugin.saveSettings();
		new Notice('Cleared cache for every source.');
      this.display();
    }, !this.hasAnyCache());
	this.createTextButton(actions, 'Add source', () => {
      const preset = this.plugin.settings.llmPresets[0];
      if (!preset) {
        new Notice('Create a preset before adding sources.');
        return;
      }
      const newSource: SourceConfig = {
        ...this.cloneSource(DEFAULT_SOURCE),
        id: this.createId('source'),
        label: this.buildAutoLabel(
          DEFAULT_SOURCE_LABEL,
          this.countSourcesOfType('filesystem') + 1,
        ),
        outputFolder: '',
        llmPresetId: preset.id,
      };
      newSource.outputFolder = this.getDefaultOutputFolder(newSource.label);
      this.plugin.settings.sources.unshift(newSource);
      this.autoLabelStates.set(newSource.id, true);
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

	actions.createEl('button', { text: 'Add preset', cls: 'ink2md-text-button' }).addEventListener('click', () => {
      const newPreset: LLMPreset = {
        ...this.clonePreset(DEFAULT_LLM_PRESET),
        id: this.createId('preset'),
        label: `Preset ${this.plugin.settings.llmPresets.length + 1}`,
      };
      this.plugin.settings.llmPresets.unshift(newPreset);
      this.expandedPresets.add(newPreset.id);
      this.presetDrafts.set(newPreset.id, this.clonePreset(newPreset));
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
    let labelInput: TextComponent | null = null;
    let isAutoLabel = this.isAutoLabel(draft);

    new Setting(container)
      .setName('Source type')
      .setDesc('Watch folders automatically or use the right sidebar dropzone view.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('filesystem', 'Folder source')
          .addOption('dropzone', 'Dropzone target')
          .setValue(draft.type ?? 'filesystem')
          .onChange((value) => {
            draft.type = value as SourceConfig['type'];
            summaryEl.setText(this.describeSource(draft));
            if (isAutoLabel) {
              const previousLabel = draft.label;
              const suggested = this.getDefaultLabelForType(
                draft.type ?? 'filesystem',
                this.getAutoLabelPositionFor(draft, draft.type ?? 'filesystem'),
              );
              draft.label = suggested;
              labelInput?.setValue(suggested);
              titleEl.setText(draft.label);
              this.maybeSyncOutputFolder(draft, previousLabel);
              this.setAutoLabelState(draft.id, true);
            }
            isAutoLabel = this.isAutoLabel(draft);
            this.display();
          }),
      );

    new Setting(container)
      .setName('Label')
      .setDesc('Shown in the source list.')
      .addText((text) => {
        labelInput = text;
        labelInput
          .setValue(draft.label)
          .onChange((value) => {
            const previousLabel = draft.label;
            const raw = value.trim();
            const defaultLabel = this.getDefaultLabelForType(
              draft.type ?? 'filesystem',
              this.getAutoLabelPositionFor(draft, draft.type ?? 'filesystem'),
            );
            draft.label = raw || defaultLabel;
            titleEl.setText(draft.label);
            const auto = raw.length === 0 || draft.label === defaultLabel;
            isAutoLabel = auto;
            this.setAutoLabelState(draft.id, auto);
            if (auto) {
              this.maybeSyncOutputFolder(draft, previousLabel);
            }
          });
      });

    this.addSettingsDivider(container);

    if (draft.type === 'filesystem') {
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
    } else {
		new Setting(container)
			.setName('Dropzone input')
			.setDesc('Drag files into the dropzone view or use its browse button.');
    }

    new Setting(container)
      .setName('Pre-import script (optional)')
      .setDesc('Command to run before importing from this source. Import only continues if it exits with code 0.')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/script.sh')
          .setValue(draft.preImportScript ?? '')
          .onChange((value) => {
            draft.preImportScript = value.trim();
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

    this.addSettingsDivider(container);

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

    this.addSettingsDivider(container);

	new Setting(container)
		.setName('Language model preset')
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
		.setDesc('Choose which provider powers this preset.')
		.addDropdown((dropdown) => {
			Object.entries(PROVIDER_LABELS).forEach(([provider, label]) => {
				dropdown.addOption(provider, label);
			});
			dropdown
				.setValue(draft.provider)
				.onChange((value) => {
					draft.provider = value as LLMProvider;
					summaryEl.setText(this.describePreset(draft));
					this.display();
				});
		});

	new Setting(container)
		.setName('Streaming')
		.setDesc('Enable to write language model tokens to disk as they arrive; disable to wait for the full response before writing.')
      .addToggle((toggle) =>
        toggle
          .setValue(draft.generationMode === 'stream')
          .onChange((value) => {
            draft.generationMode = value ? 'stream' : 'batch';
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
      this.renderOpenAIFields(providerFields, draft, this.getPresetSecretState(draft.id, 'openai'));
    } else if (draft.provider === 'azure-openai') {
      this.renderAzureOpenAIFields(providerFields, draft, this.getPresetSecretState(draft.id, 'azure-openai'));
    } else if (draft.provider === 'anthropic') {
      this.renderAnthropicFields(providerFields, draft, this.getPresetSecretState(draft.id, 'anthropic'));
    } else if (draft.provider === 'gemini') {
      this.renderGeminiFields(providerFields, draft, this.getPresetSecretState(draft.id, 'gemini'));
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
    for (const line of this.describeSecretStorageLines(draft.id, 'openai')) {
      descEl.createEl('br');
      descEl.createSpan({ text: line });
    }
    apiKeySetting.addText((text) => {
        const placeholder = '••••••••';
        const canShowPlaceholder = secretState.hasSecret && !secretState.cleared && !secretState.dirty && !draft.openAI.apiKey;
        let showingPlaceholder = false;
		text.setPlaceholder(OPENAI_KEY_PLACEHOLDER);
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
  private renderAnthropicFields(container: HTMLElement, draft: LLMPreset, secretState: PresetSecretState) {
    const apiKeySetting = new Setting(container).setName('API key');
    apiKeySetting.setDesc('');
    const descEl = apiKeySetting.descEl;
    descEl.empty();
    descEl.createSpan({ text: 'Anthropic API key used for this preset.' });
    for (const line of this.describeSecretStorageLines(draft.id, 'anthropic')) {
      descEl.createEl('br');
      descEl.createSpan({ text: line });
    }
    apiKeySetting.addText((text) => {
        const placeholder = '••••••••';
        const canShowPlaceholder = secretState.hasSecret && !secretState.cleared && !secretState.dirty && !draft.anthropic.apiKey;
        let showingPlaceholder = false;
		text.setPlaceholder(ANTHROPIC_KEY_PLACEHOLDER);
        if (canShowPlaceholder) {
          text.setValue(placeholder);
          showingPlaceholder = true;
        } else {
          text.setValue(draft.anthropic.apiKey);
        }
        text.onChange((value) => {
          if (showingPlaceholder) {
            return;
          }
          const trimmed = value.trim();
          draft.anthropic.apiKey = trimmed;
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
      .setName('Base URL')
      .setDesc('Anthropic API base URL.')
      .addText((text) =>
		text
			.setPlaceholder(ANTHROPIC_BASE_URL_PLACEHOLDER)
          .setValue(draft.anthropic.baseUrl)
          .onChange((value) => {
            draft.anthropic.baseUrl = value.trim();
          }),
      );

    new Setting(container)
      .setName('Model')
      .setDesc('Vision model name.')
      .addText((text) =>
		text
			.setPlaceholder(ANTHROPIC_MODEL_PLACEHOLDER)
          .setValue(draft.anthropic.model)
          .onChange((value) => {
            draft.anthropic.model = value.trim();
          }),
      );

    this.renderPromptTextarea(container, draft.anthropic.promptTemplate, (value) => {
      draft.anthropic.promptTemplate = value;
    });
  }

  private renderAzureOpenAIFields(container: HTMLElement, draft: LLMPreset, secretState: PresetSecretState) {
    const apiKeySetting = new Setting(container).setName('API key');
    apiKeySetting.setDesc('');
    const descEl = apiKeySetting.descEl;
    descEl.empty();
    descEl.createSpan({ text: 'Azure OpenAI API key for this preset.' });
    for (const line of this.describeSecretStorageLines(draft.id, 'azure-openai')) {
      descEl.createEl('br');
      descEl.createSpan({ text: line });
    }
    apiKeySetting.addText((text) => {
        const placeholder = '••••••••';
        const canShowPlaceholder = secretState.hasSecret && !secretState.cleared && !secretState.dirty && !draft.azureOpenAI.apiKey;
        let showingPlaceholder = false;
		text.setPlaceholder(AZURE_KEY_PLACEHOLDER);
        if (canShowPlaceholder) {
          text.setValue(placeholder);
          showingPlaceholder = true;
        } else {
          text.setValue(draft.azureOpenAI.apiKey);
        }
        text.onChange((value) => {
          if (showingPlaceholder) {
            return;
          }
          const trimmed = value.trim();
          draft.azureOpenAI.apiKey = trimmed;
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
      .setName('Endpoint')
      .setDesc('Azure resource endpoint, e.g. https://example-resource.openai.azure.com/.')
      .addText((text) =>
		text
			.setPlaceholder(AZURE_ENDPOINT_PLACEHOLDER)
          .setValue(draft.azureOpenAI.endpoint)
          .onChange((value) => {
            draft.azureOpenAI.endpoint = value.trim();
          }),
      );

    new Setting(container)
      .setName('Model')
      .setDesc('Azure OpenAI deployment/model name, e.g. gpt-5-mini.')
      .addText((text) =>
		text
			.setPlaceholder(AZURE_MODEL_PLACEHOLDER)
          .setValue(draft.azureOpenAI.deployment)
          .onChange((value) => {
            draft.azureOpenAI.deployment = value.trim();
          }),
      );

    new Setting(container)
      .setName('API version')
      .setDesc('Defaults to the SDK version recommended for your deployment.')
      .addText((text) =>
		text
			.setPlaceholder(AZURE_VERSION_PLACEHOLDER)
          .setValue(draft.azureOpenAI.apiVersion)
          .onChange((value) => {
            draft.azureOpenAI.apiVersion = value.trim();
          }),
      );

    new Setting(container)
      .setName('Image detail')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('low', 'Low')
          .addOption('high', 'High')
          .setValue(draft.azureOpenAI.imageDetail)
          .onChange((value) => {
            draft.azureOpenAI.imageDetail = value === 'high' ? 'high' : 'low';
          }),
      );

    this.renderPromptTextarea(container, draft.azureOpenAI.promptTemplate, (value) => {
      draft.azureOpenAI.promptTemplate = value;
    });
  }

  private renderGeminiFields(container: HTMLElement, draft: LLMPreset, secretState: PresetSecretState) {
    const apiKeySetting = new Setting(container).setName('API key');
    apiKeySetting.setDesc('');
    const descEl = apiKeySetting.descEl;
    descEl.empty();
    descEl.createSpan({ text: 'Gemini API key used for this preset.' });
    for (const line of this.describeSecretStorageLines(draft.id, 'gemini')) {
      descEl.createEl('br');
      descEl.createSpan({ text: line });
    }
    apiKeySetting.addText((text) => {
        const placeholder = '••••••••';
        const canShowPlaceholder = secretState.hasSecret && !secretState.cleared && !secretState.dirty && !draft.gemini.apiKey;
        let showingPlaceholder = false;
		text.setPlaceholder(GEMINI_KEY_PLACEHOLDER);
        if (canShowPlaceholder) {
          text.setValue(placeholder);
          showingPlaceholder = true;
        } else {
          text.setValue(draft.gemini.apiKey);
        }
        text.onChange((value) => {
          if (showingPlaceholder) {
            return;
          }
          const trimmed = value.trim();
          draft.gemini.apiKey = trimmed;
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
          .setValue(draft.gemini.model)
          .onChange((value) => {
            draft.gemini.model = value.trim();
          }),
      );

    this.renderPromptTextarea(container, draft.gemini.promptTemplate, (value) => {
      draft.gemini.promptTemplate = value;
    });
  }

  private renderLocalFields(container: HTMLElement, draft: LLMPreset) {
	new Setting(container)
		.setName('Endpoint URL')
		.setDesc(`HTTP endpoint that accepts ${PROVIDER_LABELS.openai}-compatible chat completions requests.`)
      .addText((text) =>
		text
			.setPlaceholder(LOCAL_ENDPOINT_PLACEHOLDER)
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
	info.createDiv({ cls: 'ink2md-section-title', text: title });
	info.createEl('p', { text: description });
    const actions = header.createDiv({ cls: 'ink2md-header-actions' });
    return { sectionEl, actions };
  }

  private describeSource(source: SourceConfig): string {
    const parts = [];
    if (source.type === 'dropzone') {
      parts.push('Dropzone view');
    } else {
      const dirCount = source.directories.length;
      if (dirCount === 0) {
        parts.push('No folders');
      } else if (dirCount === 1) {
        parts.push('1 folder');
      } else {
        parts.push(`${dirCount} folders`);
      }
    }
    const preset = this.plugin.settings.llmPresets.find((entry) => entry.id === source.llmPresetId);
    if (preset) {
      parts.push(`Preset: ${preset.label}`);
    }
    if (source.outputFolder) {
      parts.push(`Output: ${source.outputFolder}`);
    }
    return parts.join(' • ');
  }

  private describePreset(preset: LLMPreset): string {
    const providerLabel = PROVIDER_LABELS[preset.provider] ?? 'Local';
    return `Provider: ${providerLabel} • Mode: ${preset.generationMode === 'stream' ? 'Streaming' : 'Batch'}`;
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

  private getDefaultLabelForType(type: SourceType, position = 1): string {
    const normalized = this.normalizeSourceType(type);
    const base = normalized === 'dropzone' ? DEFAULT_DROPZONE_LABEL : DEFAULT_SOURCE_LABEL;
    return this.buildAutoLabel(base, position);
  }

  private isAutoLabel(source: SourceConfig): boolean {
    const stored = this.autoLabelStates.get(source.id);
    if (stored !== undefined) {
      return stored;
    }
    const baseLabel = this.normalizeSourceType(source.type ?? 'filesystem') === 'dropzone'
      ? DEFAULT_DROPZONE_LABEL
      : DEFAULT_SOURCE_LABEL;
    const auto = this.matchesLabelPattern(source.label, baseLabel);
    this.autoLabelStates.set(source.id, auto);
    return auto;
  }

  private setAutoLabelState(sourceId: string, isAuto: boolean) {
    this.autoLabelStates.set(sourceId, isAuto);
  }

  private buildAutoLabel(base: string, position: number): string {
    const normalizedPosition = Math.max(1, position);
    return `${base} ${normalizedPosition}`;
  }

  private normalizeSourceType(type?: SourceType): SourceType {
    return type === 'dropzone' ? 'dropzone' : 'filesystem';
  }

  private countSourcesOfType(type: SourceType, excludeId?: string): number {
    const normalized = this.normalizeSourceType(type);
    return this.plugin.settings.sources.reduce((total, source) => {
      if (source.id === excludeId) {
        return total;
      }
      return this.normalizeSourceType(source.type) === normalized ? total + 1 : total;
    }, 0);
  }

  private matchesLabelPattern(label: string, base: string): boolean {
    return this.parseAutoLabelNumber(label, base) !== null;
  }

  private parseAutoLabelNumber(label: string, base: string): number | null {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?:\\s+(\\d+))?$`, 'i');
    const match = label.trim().match(pattern);
    if (!match) {
      return null;
    }
    if (!match[1]) {
      return 1;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? 1 : parsed;
  }

  private matchesDefaultOutputFolderValue(value: string | undefined, label: string): boolean {
    return (value ?? '').trim() === this.getDefaultOutputFolder(label);
  }

  private maybeSyncOutputFolder(draft: SourceConfig, previousLabel: string) {
    if (this.matchesDefaultOutputFolderValue(draft.outputFolder, previousLabel)) {
      draft.outputFolder = this.getDefaultOutputFolder(draft.label);
    }
  }

  private getAutoLabelPositionFor(source: SourceConfig, overrideType?: SourceType): number {
    const type = this.normalizeSourceType(overrideType ?? source.type);
    const base = type === 'dropzone' ? DEFAULT_DROPZONE_LABEL : DEFAULT_SOURCE_LABEL;
    if (!overrideType || this.normalizeSourceType(source.type) === type) {
      const currentNumber = this.parseAutoLabelNumber(source.label, base);
      if (currentNumber) {
        return currentNumber;
      }
    }
    const count = this.countSourcesOfType(type, source.id);
    return count + 1;
  }

  private addSettingsDivider(container: HTMLElement) {
    container.createDiv({ cls: 'ink2md-setting-divider' });
  }

  private getPresetDraft(id: string, preset: LLMPreset): LLMPreset {
    if (!this.presetDrafts.has(id)) {
      this.presetDrafts.set(id, this.clonePreset(preset));
    }
    return this.presetDrafts.get(id)!;
  }

  private getPresetSecretState(
    id: string,
    provider: 'openai' | 'azure-openai' | 'gemini' | 'anthropic',
  ): PresetSecretState {
    const key = this.getSecretStateKey(id, provider);
    if (!this.presetSecretStates.has(key)) {
      const hasSecret = provider === 'openai'
        ? this.plugin.hasOpenAISecret(id)
        : provider === 'azure-openai'
          ? this.plugin.hasAzureOpenAISecret(id)
          : provider === 'gemini'
            ? this.plugin.hasGeminiSecret(id)
              : this.plugin.hasAnthropicSecret(id);
      this.presetSecretStates.set(key, {
        hasSecret,
        dirty: false,
        cleared: false,
      });
    }
    return this.presetSecretStates.get(key)!;
  }

  private getSecretStateKey(id: string, provider: 'openai' | 'azure-openai' | 'gemini' | 'anthropic'): string {
    return `${id}:${provider}`;
  }

  private clearPresetSecretStates(id: string) {
    for (const provider of ['openai', 'azure-openai', 'gemini', 'anthropic'] as const) {
      this.presetSecretStates.delete(this.getSecretStateKey(id, provider));
    }
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
		new Notice(`Cleared ${removed} cached entries.`);
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
		new Notice('At least one source is required.');
      return;
    }
    this.plugin.settings.sources = this.plugin.settings.sources.filter((source) => source.id !== sourceId);
    this.sourceDrafts.delete(sourceId);
    await this.clearSourceCache(sourceId);
    await this.plugin.saveSettings();
	new Notice('Source deleted.');
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
		new Notice('This preset is still referenced by at least one source.');
      return;
    }
	if (this.plugin.settings.llmPresets.length === 1) {
		new Notice('At least one preset is required.');
      return;
    }
    this.plugin.settings.llmPresets = this.plugin.settings.llmPresets.filter((preset) => preset.id !== presetId);
    this.presetDrafts.delete(presetId);
    this.clearPresetSecretStates(presetId);
    await this.plugin.deleteOpenAISecret(presetId);
    await this.plugin.deleteAzureOpenAISecret(presetId);
    await this.plugin.deleteGeminiSecret(presetId);
    await this.plugin.deleteAnthropicSecret(presetId);
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
      const openAISecretState = this.getPresetSecretState(presetId, 'openai');
      const azureSecretState = this.getPresetSecretState(presetId, 'azure-openai');
      const geminiSecretState = this.getPresetSecretState(presetId, 'gemini');
      const anthropicSecretState = this.getPresetSecretState(presetId, 'anthropic');
      const clone = this.clonePreset(draft);
      const supportsSecretStorage = this.plugin.supportsSecretStorage();
      if (clone.provider === 'openai') {
        const input = draft.openAI.apiKey?.trim() ?? '';
        const shouldUpdateSecret = openAISecretState.dirty && !openAISecretState.cleared && input.length > 0;
        const shouldClearSecret = openAISecretState.dirty && openAISecretState.cleared;
        if (shouldUpdateSecret) {
          await this.plugin.setOpenAISecret(clone.id, input);
          openAISecretState.hasSecret = true;
        } else if (shouldClearSecret) {
          await this.plugin.setOpenAISecret(clone.id, '');
          openAISecretState.hasSecret = false;
        }
        clone.openAI.apiKey = supportsSecretStorage ? '' : input;
        openAISecretState.dirty = false;
        openAISecretState.cleared = false;
      } else {
        await this.plugin.deleteOpenAISecret(clone.id);
        clone.openAI.apiKey = '';
        openAISecretState.hasSecret = false;
        openAISecretState.dirty = false;
        openAISecretState.cleared = false;
      }

      if (clone.provider === 'azure-openai') {
        const input = draft.azureOpenAI.apiKey?.trim() ?? '';
        const shouldUpdateSecret = azureSecretState.dirty && !azureSecretState.cleared && input.length > 0;
        const shouldClearSecret = azureSecretState.dirty && azureSecretState.cleared;
        if (shouldUpdateSecret) {
          await this.plugin.setAzureOpenAISecret(clone.id, input);
          azureSecretState.hasSecret = true;
        } else if (shouldClearSecret) {
          await this.plugin.setAzureOpenAISecret(clone.id, '');
          azureSecretState.hasSecret = false;
        }
        clone.azureOpenAI.apiKey = supportsSecretStorage ? '' : input;
        azureSecretState.dirty = false;
        azureSecretState.cleared = false;
      } else {
        await this.plugin.deleteAzureOpenAISecret(clone.id);
        clone.azureOpenAI.apiKey = '';
        azureSecretState.hasSecret = false;
        azureSecretState.dirty = false;
        azureSecretState.cleared = false;
      }

      if (clone.provider === 'gemini') {
        const input = draft.gemini.apiKey?.trim() ?? '';
        const shouldUpdateSecret = geminiSecretState.dirty && !geminiSecretState.cleared && input.length > 0;
        const shouldClearSecret = geminiSecretState.dirty && geminiSecretState.cleared;
        if (shouldUpdateSecret) {
          await this.plugin.setGeminiSecret(clone.id, input);
          geminiSecretState.hasSecret = true;
        } else if (shouldClearSecret) {
          await this.plugin.setGeminiSecret(clone.id, '');
          geminiSecretState.hasSecret = false;
        }
        clone.gemini.apiKey = supportsSecretStorage ? '' : input;
        geminiSecretState.dirty = false;
        geminiSecretState.cleared = false;
      } else {
        await this.plugin.deleteGeminiSecret(clone.id);
        clone.gemini.apiKey = '';
        geminiSecretState.hasSecret = false;
        geminiSecretState.dirty = false;
        geminiSecretState.cleared = false;
      }

      if (clone.provider === 'anthropic') {
        const input = draft.anthropic.apiKey?.trim() ?? '';
        const shouldUpdateSecret = anthropicSecretState.dirty && !anthropicSecretState.cleared && input.length > 0;
        const shouldClearSecret = anthropicSecretState.dirty && anthropicSecretState.cleared;
        if (shouldUpdateSecret) {
          await this.plugin.setAnthropicSecret(clone.id, input);
          anthropicSecretState.hasSecret = true;
        } else if (shouldClearSecret) {
          await this.plugin.setAnthropicSecret(clone.id, '');
          anthropicSecretState.hasSecret = false;
        }
        clone.anthropic.apiKey = supportsSecretStorage ? '' : input;
        anthropicSecretState.dirty = false;
        anthropicSecretState.cleared = false;
      } else {
        await this.plugin.deleteAnthropicSecret(clone.id);
        clone.anthropic.apiKey = '';
        anthropicSecretState.hasSecret = false;
        anthropicSecretState.dirty = false;
        anthropicSecretState.cleared = false;
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
    this.clearPresetSecretStates(id);
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
	setIcon(iconSpan, icon);
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

  private describeSecretStorageLines(
    presetId: string,
    provider: 'openai' | 'azure-openai' | 'gemini' | 'anthropic',
  ): string[] {
    if (!this.plugin.supportsSecretStorage()) {
      return ["Stored with plugin settings because Obsidian's keychain isn't available in this Obsidian build."];
    }
    const secretId = this.plugin.getPresetSecretId(presetId, provider);
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
					contentEl.createDiv({ cls: 'ink2md-modal-heading', text: options.title });
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
		return structuredClone(source);
	}

	private clonePreset(preset: LLMPreset): LLMPreset {
		return structuredClone(preset);
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
