import OpenAI from 'openai';
import { ConvertedNote, DeepSeekProviderSettings, MarkdownStreamHandler } from '../types';
import { buildVisionMessage, emitStreamContent, OPENAI_VISION_SYSTEM_PROMPT } from './openaiProvider';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-vl';

export class DeepSeekVisionProvider {
	private client: OpenAI;

	constructor(private readonly config: DeepSeekProviderSettings) {
		if (!config.apiKey) {
			throw new Error('DeepSeek API key is missing.');
		}
		const baseURL = config.baseUrl?.trim() || DEFAULT_BASE_URL;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL,
			dangerouslyAllowBrowser: true,
		});
	}

	async generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string> {
		const messages = await buildVisionMessage(
			note,
			this.config.promptTemplate,
			llmMaxWidth,
			this.config.imageDetail,
		);
		const response = await this.client.chat.completions.create(
			{
				model: this.resolveModel(),
				temperature: 0.2,
				messages: [
					{ role: 'system', content: OPENAI_VISION_SYSTEM_PROMPT },
					{ role: 'user', content: messages },
				],
			},
			{ signal },
		);

		const text = response.choices[0]?.message?.content?.trim();
		if (!text) {
			throw new Error('DeepSeek did not return any content.');
		}
		return text;
	}

	async streamMarkdown(
		note: ConvertedNote,
		llmMaxWidth: number,
		handler: MarkdownStreamHandler,
		signal?: AbortSignal,
	): Promise<void> {
		const messages = await buildVisionMessage(
			note,
			this.config.promptTemplate,
			llmMaxWidth,
			this.config.imageDetail,
		);
		const stream = await this.client.chat.completions.create(
			{
				model: this.resolveModel(),
				temperature: 0.2,
				stream: true,
				messages: [
					{ role: 'system', content: OPENAI_VISION_SYSTEM_PROMPT },
					{ role: 'user', content: messages },
				],
			},
			{ signal },
		);

		for await (const chunk of stream) {
			await emitStreamContent(chunk.choices[0]?.delta?.content, handler);
		}
	}

	private resolveModel(): string {
		return this.config.model?.trim() || DEFAULT_MODEL;
	}
}
