export type InputFormat = 'image' | 'pdf' | 'eink';

export interface NoteSource {
  id: string;
  format: InputFormat;
  filePath: string;
  basename: string;
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

export interface Ink2MDSettings {
  inputDirectories: string[];
  includeImages: boolean;
  includePdfs: boolean;
  includeEInk: boolean;
  attachmentMaxWidth: number;
  llmMaxWidth: number;
  pdfDpi: number;
  replaceExisting: boolean;
  outputFolder: string;
  llmProvider: LLMProvider;
  openAI: OpenAIProviderSettings;
  local: LocalProviderSettings;
  processedSources: Record<string, ProcessedSourceInfo>;
}

export interface MarkdownGenerationContext {
  note: ConvertedNote;
  llmMarkdown: string;
  imageEmbeds: Array<{ path: string; width: number }>;
}
