import { requestUrl } from 'obsidian';
import { ConvertedNote, LocalProviderSettings, MarkdownStreamHandler } from '../types';
import { scalePngBufferToDataUrl } from '../utils/pngScaler';

const SYSTEM_PROMPT = 'You are an offline assistant that reads handwriting images and emits Markdown summaries. Reply with valid Markdown only.';

interface LocalStreamTextPart {
	type?: string;
	text?: string;
}

interface LocalStreamDelta {
	content?: string | LocalStreamTextPart[];
}

type VisionContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' } }
>;

	export class LocalVisionProvider {
		constructor(private readonly config: LocalProviderSettings) {}

		async generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string> {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.config.apiKey) {
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		}

		const body = {
			model: this.config.model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{
					role: 'user',
					content: await buildVisionContent(
						note,
						this.config.promptTemplate,
						llmMaxWidth,
						this.config.imageDetail,
					),
				},
			],
		};

		const response = await requestWithAbort(signal, () =>
			requestUrl({
			url: this.config.endpoint,
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			}),
		);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Local vision endpoint responded with ${response.status}`);
		}

		const text = extractCompletionContent(response.json as unknown);
		if (!text) {
			throw new Error('Local vision endpoint did not return any content.');
		}
		return text.trim();
	}

	async streamMarkdown(
		note: ConvertedNote,
		llmMaxWidth: number,
		handler: MarkdownStreamHandler,
		signal?: AbortSignal,
	): Promise<void> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.config.apiKey) {
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		}

		const body = {
			model: this.config.model,
			stream: true,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{
					role: 'user',
					content: await buildVisionContent(
						note,
						this.config.promptTemplate,
						llmMaxWidth,
						this.config.imageDetail,
					),
				},
			],
		};

		const response = await requestWithAbort(signal, () =>
			requestUrl({
			url: this.config.endpoint,
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			}),
		);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Local vision endpoint responded with ${response.status}`);
		}

		if (!response.text) {
			throw new Error('Local vision endpoint did not return a streaming payload.');
		}

		await processSSEPayload(response.text, handler, signal);
	}
}

async function buildVisionContent(
	note: ConvertedNote,
	promptTemplate: string,
	llmMaxWidth: number,
	detail: 'low' | 'high',
): Promise<VisionContent> {
	const content: VisionContent = [
		{ type: 'text', text: `${promptTemplate}\nTitle: ${note.source.basename}` },
	];

	for (const page of note.pages) {
		const imageUrl = await scalePngBufferToDataUrl(page.data, llmMaxWidth);
		content.push({
			type: 'image_url',
			image_url: { url: imageUrl, detail },
		});
	}

	return content;
}

function extractCompletionContent(payload: unknown): string | null {
	if (!isRecord(payload)) {
		return null;
	}
	const choices = payload.choices;
	if (!Array.isArray(choices) || !choices.length) {
		return null;
	}
	const firstChoice = choices.find(isRecord);
	if (!firstChoice) {
		return null;
	}
	const messageRecord = 'message' in firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
	if (!messageRecord) {
		return null;
	}
	const content = 'content' in messageRecord ? messageRecord.content : undefined;
	return typeof content === 'string' ? content : null;
}

async function processSSEPayload(payload: string, handler: MarkdownStreamHandler, signal?: AbortSignal) {
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
		if (!data) {
			continue;
		}
		if (data === '[DONE]') {
			break;
		}
		try {
			const parsed: unknown = JSON.parse(data);
			const delta = extractDeltaFromChunk(parsed);
			if (delta) {
				await emitLocalStreamContent(delta, handler);
			}
		} catch (error) {
			console.error('[ink2md] Failed to parse streaming payload', error);
		}
	}
}

function extractDeltaFromChunk(chunk: unknown): LocalStreamDelta | null {
	if (!isRecord(chunk)) {
		return null;
	}
	const choices = chunk.choices;
	if (!Array.isArray(choices) || !choices.length) {
		return null;
	}
	const firstChoice = choices.find(isRecord);
	if (!firstChoice) {
		return null;
	}
	const deltaRecord = 'delta' in firstChoice && isRecord(firstChoice.delta) ? firstChoice.delta : null;
	if (!deltaRecord) {
		return null;
	}
	const content = 'content' in deltaRecord ? deltaRecord.content : undefined;
	if (typeof content === 'string') {
		return { content };
	}
	if (Array.isArray(content)) {
		const textParts = content.filter(isStreamTextPart);
		return { content: textParts };
	}
	return { content: undefined };
}

function isStreamTextPart(value: unknown): value is LocalStreamTextPart {
	return typeof value === 'object' && value !== null;
}

async function emitLocalStreamContent(delta: LocalStreamDelta | null, handler: MarkdownStreamHandler) {
	if (!delta || !delta.content) {
		return;
	}
	if (typeof delta.content === 'string') {
		const text = delta.content.trim();
		if (text) {
			await handler(text);
		}
		return;
	}
	for (const part of delta.content) {
		if (part?.type === 'text' && part.text) {
			await handler(part.text);
		}
	}
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
