import { ConvertedNote, Ink2MDSettings, MarkdownStreamHandler } from '../types';
import { OpenAIVisionProvider } from './openaiProvider';
import { LocalVisionProvider } from './localProvider';

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

	constructor(settings: Ink2MDSettings) {
		this.llmMaxWidth = settings.llmMaxWidth;
		if (settings.llmProvider === 'openai') {
			this.provider = new OpenAIVisionProvider(settings.openAI);
		} else {
			this.provider = new LocalVisionProvider(settings.local);
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
