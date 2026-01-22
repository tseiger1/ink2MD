import { ConvertedNote, LocalProviderSettings } from '../types';
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
