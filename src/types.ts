export type InputFormat = 'image' | 'pdf' | 'supernote';

export interface NoteSource {
  id: string;
  format: InputFormat;
  filePath: string;
  basename: string;
  inputRoot: string;
  relativeFolder: string;
}

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

export interface LocalProviderSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
  imageDetail: 'low' | 'high';
}

export interface ProcessedSourceInfo {
  hash: string;
  size: number;
  mtimeMs: number;
  processedAt: string;
  outputFolder: string;
}

export type LLMProvider = 'openai' | 'local';
export type LLMGenerationMode = 'batch' | 'stream';

export interface Ink2MDSettings {
  inputDirectories: string[];
  includeImages: boolean;
  includePdfs: boolean;
  includeSupernote: boolean;
  attachmentMaxWidth: number;
  llmMaxWidth: number;
  pdfDpi: number;
  replaceExisting: boolean;
  outputFolder: string;
  llmProvider: LLMProvider;
  llmGenerationMode: LLMGenerationMode;
  openGeneratedNotes: boolean;
  openAI: OpenAIProviderSettings;
  local: LocalProviderSettings;
  processedSources: Record<string, ProcessedSourceInfo>;
}

export interface MarkdownGenerationContext {
  note: ConvertedNote;
  llmMarkdown: string;
  imageEmbeds: ImageEmbed[];
}

export type MarkdownStreamHandler = (chunk: string) => void | Promise<void>;
