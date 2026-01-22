import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { ConvertedNote, OpenAIProviderSettings } from '../types';
import { scalePngBufferToDataUrl } from '../utils/pngScaler';

const SYSTEM_PROMPT = 'You turn images of handwriting into clean Markdown notes with headings, bullet lists, tasks, and tables when needed. Preserve the original meaning and avoid hallucinations.';

export class OpenAIVisionProvider {
  private client: OpenAI;

  constructor(private readonly config: OpenAIProviderSettings) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is missing.');
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

	async generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string> {
		const messages = await buildVisionMessage(note, this.config.promptTemplate, llmMaxWidth);
		const response = await this.client.chat.completions.create(
			{
				model: this.config.model,
				temperature: 0.2,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: messages },
				],
			},
			{ signal },
		);

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('OpenAI did not return any content.');
    }
    return text;
  }
}

async function buildVisionMessage(
  note: ConvertedNote,
  promptTemplate: string,
  llmMaxWidth: number,
): Promise<ChatCompletionContentPart[]> {
  const parts: ChatCompletionContentPart[] = [
    { type: 'text', text: `${promptTemplate}\nTitle: ${note.source.basename}` },
  ];

  for (const page of note.pages) {
    const imageUrl = await scalePngBufferToDataUrl(page.data, llmMaxWidth);
    parts.push({
      type: 'image_url',
      image_url: {
        url: imageUrl,
        detail: 'low',
      },
    });
  }

  return parts;
}
