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
}

export interface LocalProviderSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  promptTemplate: string;
}

export type LLMProvider = 'openai' | 'local';

export interface Ink2MDSettings {
  inputDirectories: string[];
  includeImages: boolean;
  includePdfs: boolean;
  includeEInk: boolean;
  maxImageWidth: number;
  outputFolder: string;
  llmProvider: LLMProvider;
  openAI: OpenAIProviderSettings;
  local: LocalProviderSettings;
}

export interface MarkdownGenerationContext {
  note: ConvertedNote;
  llmMarkdown: string;
  imagePaths: string[];
}
