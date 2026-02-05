import { requestUrl } from 'obsidian';
import { AnthropicProviderSettings, ConvertedNote, MarkdownStreamHandler } from '../types';
import { scalePngBufferToDataUrl } from '../utils/pngScaler';
import { OPENAI_VISION_SYSTEM_PROMPT } from './openaiProvider';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-3-5-sonnet-20240620';
const DEFAULT_MAX_TOKENS = 2048;
const ANTHROPIC_VERSION = '2023-06-01';

type AnthropicContentPart =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

interface AnthropicResponse {
	content?: Array<{ type?: string; text?: string }>;
}

export class AnthropicVisionProvider {
	constructor(private readonly config: AnthropicProviderSettings) {
		if (!config.apiKey) {
			throw new Error('Anthropic API key is missing.');
		}
	}

	async generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string> {
		const payload = await this.buildPayload(note, llmMaxWidth, false);
		const response = await requestWithAbort(signal, () =>
			requestUrl({
				url: `${this.resolveBaseUrl()}/v1/messages`,
				method: 'POST',
				headers: this.buildHeaders(),
				body: JSON.stringify(payload),
			}),
		);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Anthropic responded with ${response.status}`);
		}
		const text = extractAnthropicContent(response.json as AnthropicResponse);
		if (!text) {
			throw new Error('Anthropic did not return any content.');
		}
		return text.trim();
	}

	async streamMarkdown(
		note: ConvertedNote,
		llmMaxWidth: number,
		handler: MarkdownStreamHandler,
		signal?: AbortSignal,
	): Promise<void> {
		const payload = await this.buildPayload(note, llmMaxWidth, true);
		const response = await requestWithAbort(signal, () =>
			requestUrl({
				url: `${this.resolveBaseUrl()}/v1/messages`,
				method: 'POST',
				headers: this.buildHeaders(),
				body: JSON.stringify(payload),
			}),
		);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Anthropic responded with ${response.status}`);
		}
		if (!response.text) {
			throw new Error('Anthropic did not return a streaming payload.');
		}
		await processAnthropicStream(response.text, handler, signal);
	}

	private async buildPayload(note: ConvertedNote, llmMaxWidth: number, stream: boolean) {
		const content: AnthropicContentPart[] = [
			{ type: 'text', text: `${this.config.promptTemplate}\nTitle: ${note.source.basename}` },
		];
		for (const page of note.pages) {
			const imageUrl = await scalePngBufferToDataUrl(page.data, llmMaxWidth);
			const base64 = imageUrl.substring(imageUrl.indexOf(',') + 1);
			content.push({
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/png',
					data: base64,
				},
			});
		}
		return {
			model: this.resolveModel(),
			max_tokens: DEFAULT_MAX_TOKENS,
			stream,
			system: OPENAI_VISION_SYSTEM_PROMPT,
			messages: [
				{
					role: 'user',
					content,
				},
			],
		};
	}

	private resolveBaseUrl(): string {
		const baseUrl = this.config.baseUrl?.trim() || DEFAULT_BASE_URL;
		return baseUrl.replace(/\/+$/, '');
	}

	private resolveModel(): string {
		return this.config.model?.trim() || DEFAULT_MODEL;
	}

	private buildHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'x-api-key': this.config.apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
		};
	}
}

function extractAnthropicContent(payload: AnthropicResponse): string | null {
	const content = payload?.content;
	if (!Array.isArray(content)) {
		return null;
	}
	const textChunks = content
		.filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
		.map((entry) => entry.text?.trim())
		.filter((entry): entry is string => !!entry);
	return textChunks.length ? textChunks.join('\n').trim() : null;
}

async function processAnthropicStream(payload: string, handler: MarkdownStreamHandler, signal?: AbortSignal) {
	const lines = payload.split('\n');
	for (const rawLine of lines) {
		if (signal?.aborted) {
			throw createAbortError();
		}
		const line = rawLine.trim();
		if (!line || !line.startsWith('data:')) {
			continue;
		}
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(data);
			const delta = extractStreamDelta(parsed);
			if (delta) {
				await handler(delta);
			}
		} catch (error) {
			console.error('[ink2md] Failed to parse Anthropic stream payload', error);
		}
	}
}

function extractStreamDelta(payload: unknown): string | null {
	if (!isRecord(payload) || payload.type !== 'content_block_delta') {
		return null;
	}
	if (!isRecord(payload.delta)) {
		return null;
	}
	const text = payload.delta.text;
	return typeof text === 'string' && text.length > 0 ? text : null;
}

async function requestWithAbort<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
	if (!signal) {
		return task();
	}
	if (signal.aborted) {
		throw createAbortError();
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort);
			reject(createAbortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		task()
			.then((value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			})
			.catch((error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
	});
}

function createAbortError(): Error {
	const error = new Error('Aborted');
	error.name = 'AbortError';
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
