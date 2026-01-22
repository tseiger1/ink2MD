import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { ConvertedNote, OpenAIProviderSettings } from '../types';

const SYSTEM_PROMPT = 'You turn images of handwriting into clean Markdown notes with headings, bullet lists, tasks, and tables when needed. Preserve the original meaning and avoid hallucinations.';

export class OpenAIVisionProvider {
  private client: OpenAI;

  constructor(private readonly config: OpenAIProviderSettings) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is missing.');
    }
    this.client = new OpenAI({ apiKey: config.apiKey });
  }

  async generateMarkdown(note: ConvertedNote): Promise<string> {
    const messages: ChatCompletionContentPart[] = buildVisionMessage(note, this.config.promptTemplate);
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: messages },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('OpenAI did not return any content.');
    }
    return text;
  }
}

function buildVisionMessage(note: ConvertedNote, promptTemplate: string): ChatCompletionContentPart[] {
  const parts: ChatCompletionContentPart[] = [
    { type: 'text', text: `${promptTemplate}\nTitle: ${note.source.basename}` },
  ];

  for (const page of note.pages) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${page.data.toString('base64')}`,
        detail: 'low',
      },
    });
  }

  return parts;
}
