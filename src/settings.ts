import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import Ink2MDPlugin from './main';
import { Ink2MDSettings, LLMProvider } from './types';

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
  includeEInk: false,
  attachmentMaxWidth: 0,
  llmMaxWidth: 512,
  pdfDpi: 300,
  replaceExisting: false,
  outputFolder: 'Ink2MD',
  llmProvider: 'openai',
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

    this.renderDirectories(containerEl);
    this.renderFormatToggles(containerEl);
    this.renderConversion(containerEl);
    this.renderLLMSettings(containerEl);
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
      .setDesc('Folder that will be created inside the vault to store PNGs and Markdown files.')
      .addText((text) =>
        text
          .setPlaceholder('Ink2MD')
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || 'Ink2MD';
            await this.plugin.saveSettings();
          }),
      );
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
      .setName('E-ink imports (experimental stub)')
      .setDesc('Placeholder module that reports discovered files without converting them yet.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeEInk)
          .onChange(async (value) => {
            this.plugin.settings.includeEInk = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderConversion(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName('Attachment PNG width')
      .setDesc('Images saved to the vault will be scaled down when wider than this value. Set to 0 to keep the original size.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 4096, 64)
          .setValue(this.plugin.settings.attachmentMaxWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.attachmentMaxWidth = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('LLM PNG width')
      .setDesc('Pages sent to the LLM are optionally downscaled separately to reduce bandwidth and tokens. Set to 0 to keep the original size.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 2048, 32)
          .setValue(this.plugin.settings.llmMaxWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.llmMaxWidth = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('PDF render DPI')
      .setDesc('Controls the base resolution when rasterizing PDF pages. Higher values improve fidelity at the cost of larger files.')
      .addSlider((slider) =>
        slider
          .setLimits(72, 600, 12)
          .setValue(this.plugin.settings.pdfDpi)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pdfDpi = value;
            await this.plugin.saveSettings();
          }),
      );

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

    if (this.plugin.settings.llmProvider === 'openai') {
      this.renderOpenAISettings(containerEl);
    } else {
      this.renderLocalSettings(containerEl);
    }
  }

  private renderOpenAISettings(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName('API key')
      .setDesc('Stored locally inside the vault data. Required for OpenAI calls.')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openAI.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.openAI.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Vision-capable model such as gpt-4o-mini or o4-mini-high.')
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

  private renderPromptSetting(containerEl: HTMLElement, provider: 'openAI' | 'local') {
    const config = this.plugin.settings[provider];
    new Setting(containerEl)
      .setName('Prompt template')
      .setDesc('Instructions prepended to the LLM request. Keep it concise to reduce latency.')
      .addTextArea((text) => {
        text
          .setValue(config.promptTemplate)
          .onChange(async (value) => {
            config.promptTemplate = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
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
          const buttonBar = contentEl.createDiv('ink2md-modal-buttons');
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
