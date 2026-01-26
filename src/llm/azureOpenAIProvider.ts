import { AzureOpenAI } from 'openai';
import { ConvertedNote, MarkdownStreamHandler, AzureOpenAIProviderSettings } from '../types';
import { buildVisionMessage, emitStreamContent, OPENAI_VISION_SYSTEM_PROMPT } from './openaiProvider';

export class AzureOpenAIVisionProvider {
	private client: AzureOpenAI;

	constructor(private readonly config: AzureOpenAIProviderSettings) {
		const endpoint = config.endpoint?.trim();
		const deployment = config.deployment?.trim();
		if (!config.apiKey) {
			throw new Error('Azure OpenAI API key is missing.');
		}
		if (!endpoint || !deployment) {
			throw new Error('Azure OpenAI endpoint and model are required.');
		}
		this.client = new AzureOpenAI({
			apiKey: config.apiKey,
			endpoint,
			deployment,
			apiVersion: config.apiVersion?.trim() || undefined,
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
				model: this.config.deployment,
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
			throw new Error('Azure OpenAI did not return any content.');
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
				model: this.config.deployment,
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
}
