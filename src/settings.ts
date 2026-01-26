import { AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, SliderComponent } from 'obsidian';
import Ink2MDPlugin from './main';
import { Ink2MDSettings, LLMGenerationMode, LLMProvider } from './types';

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

export const DEFAULT_SETTINGS: Ink2MDSettings = {
  inputDirectories: [],
  includeImages: true,
  includePdfs: true,
  includeSupernote: true,
  attachmentMaxWidth: 0,
  llmMaxWidth: 512,
  pdfDpi: 300,
  replaceExisting: false,
  outputFolder: 'Ink2MD',
  llmProvider: 'openai',
  llmGenerationMode: 'batch',
  openGeneratedNotes: false,
  openAI: {
    apiKey: '',
    model: 'gpt-4o-mini',
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
  processedSources: {},
};

export class Ink2MDSettingTab extends PluginSettingTab {
  plugin: Ink2MDPlugin;

  constructor(app: App, plugin: Ink2MDPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Ink2MD' });

    this.renderSection(containerEl, 'Sources & destinations', (sectionEl) => {
      this.renderDirectories(sectionEl);
    }, { isFirst: true });

    this.renderSection(containerEl, 'Formats & detection', (sectionEl) => {
      this.renderFormatToggles(sectionEl);
    });

    this.renderSection(containerEl, 'Conversion & cache', (sectionEl) => {
      this.renderConversion(sectionEl);
    });

    this.renderSection(containerEl, 'LLM provider & prompts', (sectionEl) => {
      this.renderLLMSettings(sectionEl);
    });
  }

  private renderSection(
    containerEl: HTMLElement,
    title: string,
    renderContent: (sectionEl: HTMLElement) => void,
    options?: { isFirst?: boolean },
  ) {
    const sectionEl = containerEl.createDiv({ cls: 'ink2md-settings-section' });
    if (options?.isFirst) {
      sectionEl.addClass('is-first');
    }
    sectionEl.createEl('h3', { text: title });
    renderContent(sectionEl);
  }

  private renderDirectories(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName('Input directories')
      .setDesc('Absolute file-system paths, one per line. Sub-directories are scanned automatically.')
      .addTextArea((text) => {
        text
          .setPlaceholder('/Volumes/notes')
          .setValue(this.plugin.settings.inputDirectories.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.inputDirectories = value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc('Folder inside the vault where PNGs and Markdown files are stored.')
      .addSearch((search) => {
        const current = this.plugin.settings.outputFolder;
        const displayValue = current === '/' ? '/' : current;
        search
          .setPlaceholder('Ink2MD')
          .setValue(displayValue)
          .onChange(async (value) => {
            const trimmed = value.trim();
            let normalized = trimmed;
            if (!trimmed) {
              normalized = 'Ink2MD';
            }
            this.plugin.settings.outputFolder = normalized;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, search.inputEl);
      });
  }

  private renderFormatToggles(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName('Image imports')
      .setDesc('Enable to import .png, .jpg, and .webp files.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeImages)
          .onChange(async (value) => {
            this.plugin.settings.includeImages = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('PDF imports')
      .setDesc('Enable to import PDF notebooks (each page becomes a PNG).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includePdfs)
          .onChange(async (value) => {
            this.plugin.settings.includePdfs = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Supernote imports (.note)')
      .setDesc('Enable importing Supernote notebooks. Requires restart after toggling.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeSupernote)
          .onChange(async (value) => {
            this.plugin.settings.includeSupernote = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderConversion(containerEl: HTMLElement) {
    this.renderSliderSetting({
      containerEl,
      name: 'Attachment PNG width',
      desc: 'Images saved to the vault will be scaled down when wider than this value. Set to 0 to keep the original size.',
      min: 0,
      max: 4096,
      step: 64,
      value: this.plugin.settings.attachmentMaxWidth,
      formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
      onChange: async (value) => {
        this.plugin.settings.attachmentMaxWidth = value;
        await this.plugin.saveSettings();
      },
    });

    this.renderSliderSetting({
      containerEl,
      name: 'LLM PNG width',
      desc: 'Pages sent to the LLM are optionally downscaled separately to reduce bandwidth and tokens. Set to 0 to keep the original size.',
      min: 0,
      max: 2048,
      step: 32,
      value: this.plugin.settings.llmMaxWidth,
      formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
      onChange: async (value) => {
        this.plugin.settings.llmMaxWidth = value;
        await this.plugin.saveSettings();
      },
    });

    this.renderSliderSetting({
      containerEl,
      name: 'PDF render DPI',
      desc: 'Controls the base resolution when rasterizing PDF pages. Higher values improve fidelity at the cost of larger files.',
      min: 72,
      max: 600,
      step: 12,
      value: this.plugin.settings.pdfDpi,
      formatValue: (value) => `${value} DPI`,
      onChange: async (value) => {
        this.plugin.settings.pdfDpi = value;
        await this.plugin.saveSettings();
      },
    });

    new Setting(containerEl)
      .setName('Replace existing notes')
      .setDesc('When enabled, reprocessing a file overwrites the existing note and attachments.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.replaceExisting)
          .onChange(async (value) => {
            this.plugin.settings.replaceExisting = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Open generated notes during import')
      .setDesc('Automatically focus the Markdown file that is currently being written (useful for streaming mode).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openGeneratedNotes)
          .onChange(async (value) => {
            this.plugin.settings.openGeneratedNotes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Processed files cache')
      .setDesc('Reset the list of already-processed sources if files were removed externally.')
      .addButton((button) =>
        button
          .setButtonText('Reset cache')
          .onClick(async () => {
            const confirmed = await this.confirmReset();
            if (!confirmed) {
              return;
            }
            this.plugin.settings.processedSources = {};
            await this.plugin.saveSettings();
            new Notice('Ink2MD: processed file cache cleared.');
          }),
      );
  }

  private renderLLMSettings(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName('LLM provider')
      .setDesc('Switch between OpenAI vision models and a local OpenAI-compatible endpoint (e.g., llama).')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('openai', 'OpenAI')
          .addOption('local', 'Local (OpenAI compatible)')
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value) => {
            this.plugin.settings.llmProvider = value as LLMProvider;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Generation mode')
      .setDesc('Batch waits for the full response, streaming writes Markdown tokens directly to the output file.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('batch', 'Batch')
          .addOption('stream', 'Streaming')
          .setValue(this.plugin.settings.llmGenerationMode)
          .onChange(async (value) => {
            const mode: LLMGenerationMode = value === 'stream' ? 'stream' : 'batch';
            this.plugin.settings.llmGenerationMode = mode;
            await this.plugin.saveSettings();
          }),
      );

    if (this.plugin.settings.llmProvider === 'openai') {
      this.renderOpenAISettings(containerEl);
    } else {
      this.renderLocalSettings(containerEl);
    }
  }

  private renderOpenAISettings(containerEl: HTMLElement) {
    containerEl.createEl('h4', { text: 'OpenAI configuration' });
    new Setting(containerEl)
      .setName('API key')
      .setDesc('Stored using Obsidian\'s secret storage (falls back to plugin data on older app versions). Required for OpenAI calls.')
      .addText((text) => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.getOpenAISecret())
          .onChange(async (value) => {
            await this.plugin.setOpenAISecret(value);
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Vision-capable model such as gpt-5-mini, gpt-5.2 or similar.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.openAI.model)
          .onChange(async (value) => {
            this.plugin.settings.openAI.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Image detail')
      .setDesc('Controls the quality detail level sent to the vision model.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('low', 'Low')
          .addOption('high', 'High')
          .setValue(this.plugin.settings.openAI.imageDetail)
          .onChange(async (value) => {
            this.plugin.settings.openAI.imageDetail = value === 'high' ? 'high' : 'low';
            await this.plugin.saveSettings();
          }),
      );

    this.renderPromptSetting(containerEl, 'openAI');
  }

  private renderLocalSettings(containerEl: HTMLElement) {
    containerEl.createEl('h4', { text: 'Local endpoint configuration' });
    new Setting(containerEl)
      .setName('Endpoint URL')
      .setDesc('HTTP endpoint that accepts OpenAI-compatible chat completions requests.')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:11434/v1/chat/completions')
          .setValue(this.plugin.settings.local.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.local.endpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API key (optional)')
      .setDesc('Sent as Bearer token in the Authorization header when present.')
      .addText((text) =>
        text
          .setPlaceholder('secret')
          .setValue(this.plugin.settings.local.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.local.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model name')
      .setDesc('LLM identifier understood by your local server (e.g., llama-vision).')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.local.model)
          .onChange(async (value) => {
            this.plugin.settings.local.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Image detail')
      .setDesc('Choose how much detail the local vision endpoint should receive.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('low', 'Low')
          .addOption('high', 'High')
          .setValue(this.plugin.settings.local.imageDetail)
          .onChange(async (value) => {
            this.plugin.settings.local.imageDetail = value === 'high' ? 'high' : 'low';
            await this.plugin.saveSettings();
          }),
      );

    this.renderPromptSetting(containerEl, 'local');
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
    onChange: (value: number) => Promise<void>;
  }) {
    const setting = new Setting(options.containerEl)
      .setName(options.name)
      .setDesc(options.desc);

    let valueEl: HTMLSpanElement | null = null;
    const sliderComponent = new SliderComponent(setting.controlEl)
      .setLimits(options.min, options.max, options.step)
      .setValue(options.value)
      .setDynamicTooltip()
      .onChange(async (value) => {
        valueEl?.setText(options.formatValue(value));
        await options.onChange(value);
      });

    valueEl = setting.controlEl.createSpan({
      cls: 'ink2md-slider-value',
      text: options.formatValue(options.value),
    });
    sliderComponent.sliderEl.insertAdjacentElement('afterend', valueEl);
  }

  private renderPromptSetting(containerEl: HTMLElement, provider: 'openAI' | 'local') {
    const config = this.plugin.settings[provider];
    const setting = new Setting(containerEl)
      .setName('Prompt template')
      .setDesc('Instructions prepended to the LLM request. Keep it concise to reduce latency.');
    setting.settingEl.addClass('ink2md-prompt-setting');

    setting.controlEl.empty();
    setting.controlEl.addClass('ink2md-prompt-control');
    const textArea = setting.controlEl.createEl('textarea', {
      cls: 'ink2md-prompt-input',
      text: config.promptTemplate,
    });
    textArea.rows = 10;
    textArea.addEventListener('input', () => {
      config.promptTemplate = textArea.value;
    });
    textArea.addEventListener('change', async () => {
      config.promptTemplate = textArea.value.trim();
      await this.plugin.saveSettings();
    });
  }

  private async confirmReset(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new class extends Modal {
        constructor(app: App, private readonly onConfirm: (result: boolean) => void) {
          super(app);
        }

        onOpen() {
          const { contentEl } = this;
          contentEl.createEl('h3', { text: 'Reset processed files?' });
          contentEl.createEl('p', {
            text: 'This clears the cache of already-imported files so the next import reprocesses everything.',
          });
          const buttonBar = contentEl.createDiv({ cls: 'ink2md-modal-buttons' });
          const cancel = buttonBar.createEl('button', { text: 'Cancel' });
          const confirm = buttonBar.createEl('button', { text: 'Reset' });
          confirm.addClass('mod-warning');
          cancel.addEventListener('click', () => {
            this.close();
            this.onConfirm(false);
          });
          confirm.addEventListener('click', () => {
            this.close();
            this.onConfirm(true);
          });
        }

        onClose() {
          this.contentEl.empty();
        }
      }(this.app, resolve);
      modal.open();
    });
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

  selectSuggestion(folder: string, _evt: MouseEvent | KeyboardEvent) {
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
