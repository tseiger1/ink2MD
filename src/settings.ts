import { AbstractInputSuggest, App, Modal, Notice, PluginSettingTab, Setting, SliderComponent } from 'obsidian';
import Ink2MDPlugin from './main';
import { Ink2MDSettings, LLMGenerationMode, LLMProvider, LLMPreset, SourceConfig } from './types';

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

const DEFAULT_LLM_PRESET: LLMPreset = {
	id: DEFAULT_PRESET_ID,
	label: 'Default preset',
	provider: 'openai',
	generationMode: 'batch',
	llmMaxWidth: 512,
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
};

const DEFAULT_SOURCE: SourceConfig = {
	id: DEFAULT_SOURCE_ID,
	label: 'Default source',
	type: 'filesystem',
	directories: [],
	recursive: true,
	includeImages: true,
	includePdfs: true,
	includeSupernote: true,
	attachmentMaxWidth: 0,
	pdfDpi: 300,
	replaceExisting: false,
	outputFolder: 'Ink2MD',
	openGeneratedNotes: false,
	openInNewLeaf: true,
	llmPresetId: DEFAULT_PRESET_ID,
};

export const DEFAULT_SETTINGS: Ink2MDSettings = {
	sources: [DEFAULT_SOURCE],
	llmPresets: [DEFAULT_LLM_PRESET],
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
		this.renderSourcesSection(containerEl);
		this.renderPresetsSection(containerEl);
	}

	private renderSourcesSection(containerEl: HTMLElement) {
		const sectionEl = this.createSection(
			containerEl,
			'Sources',
			'Define folders to watch and how their imports should behave. Each source can use a different preset.',
		);

		new Setting(sectionEl)
			.setName('Sources')
			.setDesc('Add inputs for different notebook exports or workflows.')
			.addButton((button) =>
				button
					.setButtonText('+ Add source')
					.onClick(() => this.openSourceModal()),
			);

		for (const source of this.plugin.settings.sources) {
			this.renderSourceRow(sectionEl, source);
		}

		new Setting(sectionEl)
			.setName('Processed files cache')
			.setDesc('Reset the global cache if files were removed or renamed outside of Ink2MD.')
			.addButton((button) =>
				button
					.setButtonText('Reset all')
					.onClick(async () => {
						const confirmed = await this.confirmReset();
						if (!confirmed) {
							return;
						}
						this.plugin.settings.processedSources = {};
						await this.plugin.saveSettings();
						new Notice('Ink2MD: processed cache cleared.');
					}),
			);
	}

	private renderSourceRow(containerEl: HTMLElement, source: SourceConfig) {
		const preset = this.plugin.settings.llmPresets.find((entry) => entry.id === source.llmPresetId);
		const directories = source.directories.length ? source.directories.join(', ') : 'No directories configured';
		const desc = `Folders: ${directories}\nLLM preset: ${preset?.label ?? 'Not set'}`;
		const row = new Setting(containerEl)
			.setName(source.label)
			.setDesc(desc);
		row.addExtraButton((button) =>
			button
				.setIcon('refresh-ccw')
				.setTooltip('Clear cache for this source')
				.onClick(async () => {
					await this.clearSourceCache(source.id);
				}),
		);
		row.addExtraButton((button) =>
			button
				.setIcon('pencil')
				.setTooltip('Edit source')
				.onClick(() => this.openSourceModal(source)),
		);
		row.addExtraButton((button) =>
			button
				.setIcon('trash')
				.setTooltip('Delete source')
				.onClick(async () => {
					await this.deleteSource(source.id);
				}),
		);
	}

	private renderPresetsSection(containerEl: HTMLElement) {
		const sectionEl = this.createSection(
			containerEl,
			'LLM presets',
			'Preset groups hold provider credentials, prompts, and streaming mode. Sources reference them.',
		);

		new Setting(sectionEl)
			.setName('Presets')
			.setDesc('Create multiple presets to switch between OpenAI and local endpoints on demand.')
			.addButton((button) =>
				button
					.setButtonText('+ Add preset')
					.onClick(() => this.openPresetModal()),
			);

		for (const preset of this.plugin.settings.llmPresets) {
			const desc = `Provider: ${preset.provider === 'openai' ? 'OpenAI' : 'Local'} • Mode: ${preset.generationMode === 'stream' ? 'Streaming' : 'Batch'}`;
			const row = new Setting(sectionEl)
				.setName(preset.label)
				.setDesc(desc);
			row.addExtraButton((button) =>
				button
					.setIcon('pencil')
					.setTooltip('Edit preset')
					.onClick(() => this.openPresetModal(preset)),
			);
			row.addExtraButton((button) =>
				button
					.setIcon('trash')
					.setTooltip('Delete preset')
					.onClick(async () => {
						await this.deletePreset(preset.id);
					}),
			);
		}
	}

	private createSection(containerEl: HTMLElement, title: string, description: string) {
		const sectionEl = containerEl.createDiv({ cls: 'ink2md-settings-section' });
		sectionEl.createEl('h3', { text: title });
		sectionEl.createEl('p', { text: description });
		return sectionEl;
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
		new Notice(removed ? `Ink2MD: cleared ${removed} cached entries.` : 'Ink2MD: no cached entries for this source.');
	}

	private async deleteSource(sourceId: string) {
		if (this.plugin.settings.sources.length === 1) {
			new Notice('Ink2MD: at least one source is required.');
			return;
		}
		this.plugin.settings.sources = this.plugin.settings.sources.filter((source) => source.id !== sourceId);
		await this.clearSourceCache(sourceId);
		await this.plugin.saveSettings();
		this.display();
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
		await this.plugin.saveSettings();
		this.display();
	}

	private openSourceModal(source?: SourceConfig) {
		const presets = this.plugin.settings.llmPresets;
		if (!presets.length) {
			new Notice('Create an LLM preset before adding sources.');
			return;
		}
		const draft: SourceConfig = source
			? { ...source, directories: [...source.directories] }
				: {
					...DEFAULT_SOURCE,
					id: createId('source'),
					label: `Source ${this.plugin.settings.sources.length + 1}`,
					llmPresetId: presets[0]!.id,
				};
		const modal = new SourceEditorModal(this.app, this.plugin, presets, draft, async (updated) => {
			const existingIndex = this.plugin.settings.sources.findIndex((entry) => entry.id === updated.id);
			if (existingIndex >= 0) {
				this.plugin.settings.sources[existingIndex] = updated;
			} else {
				this.plugin.settings.sources.unshift(updated);
			}
			await this.plugin.saveSettings();
			this.display();
		});
		modal.open();
	}

	private openPresetModal(preset?: LLMPreset) {
		const draft: LLMPreset = preset
			? {
				...preset,
				openAI: { ...preset.openAI },
				local: { ...preset.local },
			}
			: {
				...DEFAULT_LLM_PRESET,
				id: createId('preset'),
				label: `Preset ${this.plugin.settings.llmPresets.length + 1}`,
			};
		const modal = new PresetEditorModal(this.app, this.plugin, draft, async (updated) => {
			const existingIndex = this.plugin.settings.llmPresets.findIndex((entry) => entry.id === updated.id);
			if (existingIndex >= 0) {
				this.plugin.settings.llmPresets[existingIndex] = updated;
			} else {
				this.plugin.settings.llmPresets.push(updated);
			}
			await this.plugin.saveSettings();
			this.display();
		});
		modal.open();
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

class SourceEditorModal extends Modal {
	private draft: SourceConfig;
	private readonly presets: LLMPreset[];
	private readonly onSave: (source: SourceConfig) => Promise<void> | void;
	private readonly plugin: Ink2MDPlugin;

	constructor(app: App, plugin: Ink2MDPlugin, presets: LLMPreset[], draft: SourceConfig, onSave: (source: SourceConfig) => Promise<void> | void) {
		super(app);
		this.plugin = plugin;
		this.presets = presets;
		this.draft = { ...draft, directories: [...draft.directories] };
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		const isNew = !this.plugin.settings.sources.some((entry) => entry.id === this.draft.id);
		contentEl.createEl('h3', { text: isNew ? 'Add source' : 'Edit source' });

		new Setting(contentEl)
			.setName('Label')
			.setDesc('Displayed in the source list.')
			.addText((text) =>
				text
					.setValue(this.draft.label)
					.onChange((value) => {
						this.draft.label = value.trim() || this.draft.label;
					}),
			);

		new Setting(contentEl)
			.setName('Source type')
			.setDesc('Currently only local file-system scanning is supported.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('filesystem', 'File system')
					.setValue('filesystem')
					.setDisabled(true),
			);

		const directories = contentEl.createEl('textarea', {
			cls: 'ink2md-source-directories',
			text: this.draft.directories.join('\n'),
		});
		directories.rows = 4;
		new Setting(contentEl)
			.setName('Directories')
			.setDesc('Absolute paths, one per line. Sub-folders are included when recursive is enabled.');
		directories.addEventListener('input', () => {
			this.draft.directories = directories.value
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean);
		});

		new Setting(contentEl)
			.setName('Recursive scan')
			.setDesc('When enabled, Ink2MD walks all sub-folders inside the configured paths.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.draft.recursive)
					.onChange((value) => {
						this.draft.recursive = value;
					}),
			);

		new Setting(contentEl)
			.setName('File types')
			.setDesc('Choose which importers run for this source.')
			.addToggle((toggle) =>
				toggle
					.setTooltip('Images (.png/.jpg/.webp)')
					.setValue(this.draft.includeImages)
					.onChange((value) => (this.draft.includeImages = value)))
			.addToggle((toggle) =>
				toggle
					.setTooltip('PDFs')
					.setValue(this.draft.includePdfs)
					.onChange((value) => (this.draft.includePdfs = value)))
			.addToggle((toggle) =>
				toggle
					.setTooltip('Supernote (.note)')
					.setValue(this.draft.includeSupernote)
					.onChange((value) => (this.draft.includeSupernote = value)));

		new Setting(contentEl)
			.setName('Output folder')
			.setDesc('Vault folder where converted notes should be stored.')
			.addSearch((search) => {
				search
					.setPlaceholder('Ink2MD')
					.setValue(this.draft.outputFolder)
					.onChange((value) => {
						this.draft.outputFolder = value.trim() || 'Ink2MD';
					});
				new FolderSuggest(this.app, search.inputEl);
			});

		new Setting(contentEl)
			.setName('Replace existing')
			.setDesc('Overwrite previous imports instead of creating timestamped folders.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.draft.replaceExisting)
					.onChange((value) => (this.draft.replaceExisting = value)));

		this.renderSliderSetting({
			containerEl: contentEl,
			name: 'Attachment width',
			desc: 'Scale images saved to the vault down to this width. Set to 0 to keep the original size.',
			min: 0,
			max: 4096,
			step: 64,
			value: this.draft.attachmentMaxWidth,
			formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
			onChange: (value) => {
				this.draft.attachmentMaxWidth = value;
			},
		});

		this.renderSliderSetting({
			containerEl: contentEl,
			name: 'PDF render DPI',
			desc: 'Controls the base resolution when rasterizing PDF pages.',
			min: 72,
			max: 600,
			step: 12,
			value: this.draft.pdfDpi,
			formatValue: (value) => `${value} DPI`,
			onChange: (value) => {
				this.draft.pdfDpi = value;
			},
		});

		new Setting(contentEl)
			.setName('Open generated notes automatically')
			.setDesc('Useful when streaming so you can watch notes update live.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.draft.openGeneratedNotes)
					.onChange((value) => (this.draft.openGeneratedNotes = value)));

		new Setting(contentEl)
			.setName('Open location')
			.setDesc('Choose where the file opens when auto-open is enabled.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('new', 'New tab')
					.addOption('current', 'Current tab')
					.setDisabled(!this.draft.openGeneratedNotes)
					.setValue(this.draft.openInNewLeaf ? 'new' : 'current')
					.onChange((value) => {
						this.draft.openInNewLeaf = value !== 'current';
					}));

		new Setting(contentEl)
			.setName('LLM preset')
			.setDesc('Select which LLM configuration drives this source.')
			.addDropdown((dropdown) => {
				dropdown
						.addOptions(
							Object.fromEntries(this.presets.map((preset) => [preset.id, preset.label])),
						)
						.setValue(this.draft.llmPresetId ?? this.presets[0]!.id)
					.onChange((value) => {
						this.draft.llmPresetId = value;
					});
			});

		const buttonBar = contentEl.createDiv({ cls: 'ink2md-modal-buttons' });
		buttonBar.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const saveBtn = buttonBar.createEl('button', { text: 'Save' });
		saveBtn.classList.add('mod-cta');
		saveBtn.addEventListener('click', async () => {
			await this.onSave({ ...this.draft });
			this.close();
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
}

class PresetEditorModal extends Modal {
	private draft: LLMPreset;
	private readonly onSave: (preset: LLMPreset) => Promise<void> | void;
	private readonly plugin: Ink2MDPlugin;
	private openAiKey: string;

	constructor(app: App, plugin: Ink2MDPlugin, draft: LLMPreset, onSave: (preset: LLMPreset) => Promise<void> | void) {
		super(app);
		this.plugin = plugin;
		this.draft = draft;
		this.onSave = onSave;
		this.openAiKey = this.plugin.getOpenAISecret(this.draft.id);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		const isNew = !this.plugin.settings.llmPresets.some((entry) => entry.id === this.draft.id);
		contentEl.createEl('h3', { text: isNew ? 'Add preset' : 'Edit preset' });

		new Setting(contentEl)
			.setName('Label')
			.setDesc('Displayed in source dropdowns.')
			.addText((text) =>
				text
					.setValue(this.draft.label)
					.onChange((value) => {
						this.draft.label = value.trim() || this.draft.label;
					}),
			);

		new Setting(contentEl)
			.setName('Provider')
			.setDesc('Choose between hosted OpenAI models or a local OpenAI-compatible endpoint.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('openai', 'OpenAI')
					.addOption('local', 'Local')
					.setValue(this.draft.provider)
					.onChange((value) => {
						this.draft.provider = value as LLMProvider;
						this.displayProviderFields(contentEl);
					}),
			);

		new Setting(contentEl)
			.setName('Generation mode')
			.setDesc('Streaming writes Markdown tokens directly to disk; batch waits for the full response.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('batch', 'Batch')
					.addOption('stream', 'Streaming')
					.setValue(this.draft.generationMode)
					.onChange((value) => {
						this.draft.generationMode = value as LLMGenerationMode;
					}),
			);

		this.renderSliderSetting({
			containerEl: contentEl,
			name: 'LLM image width',
			desc: 'Pages sent to the LLM can be downscaled separately to reduce tokens and bandwidth.',
			min: 0,
			max: 2048,
			step: 32,
			value: this.draft.llmMaxWidth,
			formatValue: (value) => (value === 0 ? 'Original size' : `${value}px`),
			onChange: (value) => {
				this.draft.llmMaxWidth = value;
			},
		});

		this.displayProviderFields(contentEl);

		const buttonBar = contentEl.createDiv({ cls: 'ink2md-modal-buttons' });
		buttonBar.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		const saveBtn = buttonBar.createEl('button', { text: 'Save' });
		saveBtn.classList.add('mod-cta');
		saveBtn.addEventListener('click', async () => {
			if (this.draft.provider === 'openai') {
				await this.plugin.setOpenAISecret(this.draft.id, this.openAiKey);
			}
			await this.onSave({ ...this.draft, openAI: { ...this.draft.openAI, apiKey: '' } });
			this.close();
		});
	}

	private displayProviderFields(contentEl: HTMLElement) {
		contentEl.querySelectorAll('.ink2md-provider-fields').forEach((el) => el.remove());
		if (this.draft.provider === 'openai') {
			this.renderOpenAIFields(contentEl);
		} else {
			this.renderLocalFields(contentEl);
		}
	}

	private renderOpenAIFields(contentEl: HTMLElement) {
		const container = contentEl.createDiv({ cls: 'ink2md-provider-fields' });
		new Setting(container)
			.setName('API key')
			.setDesc('Stored securely when available. Required for OpenAI requests.')
			.addText((text) => {
				text
					.setPlaceholder('sk-...')
					.setValue(this.openAiKey)
					.onChange((value) => {
						this.openAiKey = value.trim();
					});
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
			});

		new Setting(container)
			.setName('Model')
			.setDesc('Vision-capable OpenAI model, e.g., gpt-4o-mini.')
			.addText((text) =>
				text
					.setValue(this.draft.openAI.model)
					.onChange((value) => (this.draft.openAI.model = value.trim())));

		new Setting(container)
			.setName('Image detail')
			.setDesc('Controls the detail level sent to the vision model.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('low', 'Low')
					.addOption('high', 'High')
					.setValue(this.draft.openAI.imageDetail)
					.onChange((value) => (this.draft.openAI.imageDetail = value as 'low' | 'high')));

		this.renderPromptTextarea(container, this.draft.openAI.promptTemplate, (value) => {
			this.draft.openAI.promptTemplate = value;
		});
	}

	private renderLocalFields(contentEl: HTMLElement) {
		const container = contentEl.createDiv({ cls: 'ink2md-provider-fields' });
		new Setting(container)
			.setName('Endpoint URL')
			.setDesc('HTTP endpoint that accepts OpenAI-compatible chat completion requests.')
			.addText((text) =>
				text
					.setPlaceholder('http://localhost:11434/v1/chat/completions')
					.setValue(this.draft.local.endpoint)
					.onChange((value) => (this.draft.local.endpoint = value.trim())));

		new Setting(container)
			.setName('API key (optional)')
			.setDesc('Sent as a Bearer token when provided.')
			.addText((text) =>
				text
					.setValue(this.draft.local.apiKey)
					.onChange((value) => (this.draft.local.apiKey = value.trim())));

		new Setting(container)
			.setName('Model name')
			.setDesc('Identifier understood by your local server.')
			.addText((text) =>
				text
					.setValue(this.draft.local.model)
					.onChange((value) => (this.draft.local.model = value.trim())));

		new Setting(container)
			.setName('Image detail')
			.setDesc('Choose how much detail to request.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('low', 'Low')
					.addOption('high', 'High')
					.setValue(this.draft.local.imageDetail)
					.onChange((value) => (this.draft.local.imageDetail = value as 'low' | 'high')));

		this.renderPromptTextarea(container, this.draft.local.promptTemplate, (value) => {
			this.draft.local.promptTemplate = value;
		});
	}

	private renderPromptTextarea(container: HTMLElement, value: string, onChange: (value: string) => void) {
		const setting = new Setting(container)
			.setName('Prompt template')
			.setDesc('Prepended to the LLM request. Keep it concise to reduce latency.');
		setting.settingEl.addClass('ink2md-prompt-setting');
		setting.controlEl.empty();
		setting.controlEl.addClass('ink2md-prompt-control');
		const textArea = setting.controlEl.createEl('textarea', {
			cls: 'ink2md-prompt-input',
			text: value,
		});
		textArea.rows = 10;
		textArea.addEventListener('input', () => onChange(textArea.value));
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
}

function createId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
