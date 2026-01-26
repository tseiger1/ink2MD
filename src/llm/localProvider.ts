import { ConvertedNote, LocalProviderSettings, MarkdownStreamHandler } from '../types';
import { scalePngBufferToDataUrl } from '../utils/pngScaler';

const SYSTEM_PROMPT = 'You are an offline assistant that reads handwriting images and emits Markdown summaries. Reply with valid Markdown only.';

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

			const response = await fetch(this.config.endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal,
			});

    if (!response.ok) {
      throw new Error(`Local vision endpoint responded with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const text: string | undefined = payload?.choices?.[0]?.message?.content;
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

		const response = await fetch(this.config.endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			throw new Error(`Local vision endpoint responded with ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error('Local vision endpoint did not return a readable stream.');
		}

		await consumeSSE(response.body, handler);
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

async function consumeSSE(stream: ReadableStream<Uint8Array>, handler: MarkdownStreamHandler) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			buffer += decoder.decode();
			await drainBuffer(buffer, handler);
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const result = await drainBuffer(buffer, handler);
		buffer = result.remaining;
		if (result.done) {
			return;
		}
	}
}

async function drainBuffer(buffer: string, handler: MarkdownStreamHandler): Promise<{ remaining: string; done: boolean }> {
	let rest = buffer;
	while (true) {
		const newlineIndex = rest.indexOf('\n');
		if (newlineIndex === -1) {
			break;
		}
		const rawLine = rest.slice(0, newlineIndex).trim();
		rest = rest.slice(newlineIndex + 1);
		if (!rawLine) {
			continue;
		}
		if (!rawLine.startsWith('data:')) {
			continue;
		}
		const payload = rawLine.slice(5).trim();
		if (!payload) {
			continue;
		}
		if (payload === '[DONE]') {
			return { remaining: '', done: true };
		}
			try {
				const parsed = JSON.parse(payload);
				await emitLocalStreamContent(parsed?.choices?.[0]?.delta, handler);
			} catch (error) {
				console.error('[ink2md] Failed to parse streaming payload', error);
			}
		}
		return { remaining: rest, done: false };
}

async function emitLocalStreamContent(delta: unknown, handler: MarkdownStreamHandler) {
	const content = typeof delta === 'object' && delta !== null && 'content' in (delta as Record<string, unknown>)
		? (delta as { content?: unknown }).content
		: delta;
	if (!content) {
		return;
	}
	if (typeof content === 'string') {
		if (content) {
			await handler(content);
		}
		return;
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === 'object' && (part as { type?: string; text?: string }).type === 'text') {
				const text = (part as { text?: string }).text;
				if (text) {
					await handler(text);
				}
			}
		}
	}
}
