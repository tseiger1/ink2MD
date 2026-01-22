import { ConvertedNote, Ink2MDSettings } from '../types';
import { OpenAIVisionProvider } from './openaiProvider';
import { LocalVisionProvider } from './localProvider';

interface VisionProvider {
	generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string>;
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
}
