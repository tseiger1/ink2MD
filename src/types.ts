export type InputFormat = 'image' | 'pdf';

export type SourceType = 'filesystem' | 'dropzone';

export interface NoteSource {
	id: string;
	sourceId: string;
	format: InputFormat;
	filePath: string;
	basename: string;
	inputRoot: string;
	relativeFolder: string;
	originalPath?: string;
}

import type { Buffer } from 'buffer';

export interface ConvertedPage {
	pageNumber: number;
	fileName: string;
	width: number;
	height: number;
	data: Buffer;
}

export interface ConvertedNote {
	source: NoteSource;
	pages: ConvertedPage[];
}

export interface ImageEmbed {
	path: string;
	width: number;
}

export interface OpenAIProviderSettings {
	apiKey: string;
	model: string;
	promptTemplate: string;
	imageDetail: 'low' | 'high';
}

export interface AzureOpenAIProviderSettings {
	apiKey: string;
	endpoint: string;
	deployment: string;
	apiVersion: string;
	promptTemplate: string;
	imageDetail: 'low' | 'high';
}

export interface LocalProviderSettings {
	endpoint: string;
	apiKey: string;
	model: string;
	promptTemplate: string;
	imageDetail: 'low' | 'high';
}

export interface GeminiProviderSettings {
	apiKey: string;
	model: string;
	promptTemplate: string;
}

export interface AnthropicProviderSettings {
	apiKey: string;
	baseUrl: string;
	model: string;
	promptTemplate: string;
}

export type LLMProvider = 'openai' | 'azure-openai' | 'local' | 'gemini' | 'anthropic';
export type LLMGenerationMode = 'batch' | 'stream';

export interface LLMPreset {
	id: string;
	label: string;
	provider: LLMProvider;
	generationMode: LLMGenerationMode;
	llmMaxWidth: number;
	openAI: OpenAIProviderSettings;
	azureOpenAI: AzureOpenAIProviderSettings;
	local: LocalProviderSettings;
	gemini: GeminiProviderSettings;
	anthropic: AnthropicProviderSettings;
}

export interface SourceConfig {
	id: string;
	label: string;
	type: SourceType;
	directories: string[];
	recursive: boolean;
	includeImages: boolean;
	includePdfs: boolean;
	attachmentMaxWidth: number;
	pdfDpi: number;
	replaceExisting: boolean;
	outputFolder: string;
	openGeneratedNotes: boolean;
	openInNewLeaf: boolean;
	llmPresetId: string | null;
	preImportScript?: string;
}

export interface ProcessedSourceInfo {
	hash: string;
	size: number;
	mtimeMs: number;
	processedAt: string;
	outputFolder: string;
	sourceId: string;
}

export interface Ink2MDSettings {
	sources: SourceConfig[];
	llmPresets: LLMPreset[];
	processedSources: Record<string, ProcessedSourceInfo>;
	secretBindings: Record<string, Record<string, string>>;
}

export interface MarkdownGenerationContext {
	note: ConvertedNote;
	llmMarkdown: string;
	imageEmbeds: ImageEmbed[];
}

export type MarkdownStreamHandler = (chunk: string) => void | Promise<void>;
