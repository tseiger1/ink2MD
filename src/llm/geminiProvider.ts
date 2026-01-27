import { GoogleGenAI } from '@google/genai';
import { ConvertedNote, GeminiProviderSettings, MarkdownStreamHandler } from '../types';
import { scalePngBufferToDataUrl } from '../utils/pngScaler';

const SYSTEM_PROMPT = 'You are a meticulous assistant that transcribes handwriting from supplied images into clean Markdown. Avoid hallucinations and keep the author\'s intent.';

type GeminiContentPart =
  | { text: string }
  | {
      inlineData: {
        mimeType: string;
        data: string;
      };
    };

interface GeminiContent {
  role: 'user';
  parts: GeminiContentPart[];
}

export class GeminiVisionProvider {
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: GeminiProviderSettings) {
    if (!config.apiKey) {
      throw new Error('Gemini API key is missing.');
    }
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateMarkdown(note: ConvertedNote, llmMaxWidth: number, signal?: AbortSignal): Promise<string> {
    const payload = await this.buildContentPayload(note, llmMaxWidth);
    const response = await this.ai.models.generateContent({
      model: this.normalizeModelName(this.config.model),
      contents: payload.contents,
      config: payload.config,
    });
    const text = response?.text;
    if (!text) {
      throw new Error('Gemini did not return any content.');
    }
    return text;
  }

  async streamMarkdown(
    note: ConvertedNote,
    llmMaxWidth: number,
    handler: MarkdownStreamHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    const payload = await this.buildContentPayload(note, llmMaxWidth);
    let emitted = false;
    let accumulated = '';
    console.debug('[ink2md] Gemini streaming start');
    try {
      const stream = await this.ai.models.generateContentStream({
        model: this.normalizeModelName(this.config.model),
        contents: payload.contents,
        config: payload.config,
      });
      for await (const chunk of stream) {
        console.debug('[ink2md] Gemini chunk', chunk);
        const text = chunk?.text;
        if (text) {
          const delta = text.startsWith(accumulated) ? text.slice(accumulated.length) : text;
          accumulated = text;
          if (delta) {
            emitted = true;
            await handler(delta);
          }
        }
      }
    } catch (error) {
      console.warn('[ink2md] Gemini streaming failed; falling back to batch.', error);
    }
    if (!emitted) {
      console.debug('[ink2md] Gemini stream produced no chunks; falling back to batch response.');
      const fallback = await this.generateMarkdown(note, llmMaxWidth, signal);
      if (fallback) {
        await handler(fallback);
      }
    }
  }

  private async buildContentPayload(note: ConvertedNote, llmMaxWidth: number): Promise<{
    contents: GeminiContent[];
    config: { temperature: number };
  }> {
    const parts: GeminiContentPart[] = [
      { text: `${SYSTEM_PROMPT}\n${this.config.promptTemplate}\nTitle: ${note.source.basename}` },
    ];
    for (const page of note.pages) {
      const dataUrl = await scalePngBufferToDataUrl(page.data, llmMaxWidth);
      const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: base64,
        },
      });
    }
    return {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      config: {
        temperature: 0.2,
      },
    };
  }

  private normalizeModelName(model: string): string {
    const trimmed = model?.trim() || 'gemini-1.5-flash';
    return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
  }
}
