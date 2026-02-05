import { ConvertedNote, LLMPreset, MarkdownStreamHandler } from '../types';
import { OpenAIVisionProvider } from './openaiProvider';
import { AzureOpenAIVisionProvider } from './azureOpenAIProvider';
import { LocalVisionProvider } from './localProvider';
import { GeminiVisionProvider } from './geminiProvider';
import { DeepSeekVisionProvider } from './deepseekProvider';

interface VisionProvider {
	generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string>;
	streamMarkdown?: (
		note: ConvertedNote,
		llmMaxWidth: number,
		handler: MarkdownStreamHandler,
		signal?: AbortSignal,
	) => Promise<void>;
}

export class LLMService {
	private provider: VisionProvider;
	private llmMaxWidth: number;

	constructor(preset: LLMPreset) {
		this.llmMaxWidth = preset.llmMaxWidth;
		if (preset.provider === 'openai') {
			this.provider = new OpenAIVisionProvider(preset.openAI);
		} else if (preset.provider === 'azure-openai') {
			this.provider = new AzureOpenAIVisionProvider(preset.azureOpenAI);
		} else if (preset.provider === 'deepseek') {
			this.provider = new DeepSeekVisionProvider(preset.deepseek);
		} else if (preset.provider === 'gemini') {
			this.provider = new GeminiVisionProvider(preset.gemini);
		} else {
			this.provider = new LocalVisionProvider(preset.local);
		}
	}

	generateMarkdown(note: ConvertedNote, signal?: AbortSignal): Promise<string> {
		return this.provider.generateMarkdown(note, this.llmMaxWidth, signal);
	}

	async streamMarkdown(
		note: ConvertedNote,
		handler: MarkdownStreamHandler,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.provider.streamMarkdown) {
			throw new Error('Streaming is not supported by the selected LLM provider.');
		}
		await this.provider.streamMarkdown(note, this.llmMaxWidth, handler, signal);
	}
}
