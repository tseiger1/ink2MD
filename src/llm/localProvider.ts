import { ConvertedNote, LocalProviderSettings } from '../types';

const SYSTEM_PROMPT = 'You are an offline assistant that reads handwriting images and emits Markdown summaries. Reply with valid Markdown only.';

type VisionContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' } }
>;

export class LocalVisionProvider {
  constructor(private readonly config: LocalProviderSettings) {}

  async generateMarkdown(note: ConvertedNote): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildVisionContent(note, this.config.promptTemplate) },
      ],
    };

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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

function buildVisionContent(note: ConvertedNote, promptTemplate: string): VisionContent {
  const content: VisionContent = [
    { type: 'text', text: `${promptTemplate}\nTitle: ${note.source.basename}` },
  ];

  for (const page of note.pages) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${page.data.toString('base64')}`, detail: 'low' },
    });
  }

  return content;
}
