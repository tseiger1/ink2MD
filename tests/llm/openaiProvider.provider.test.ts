import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { OpenAIVisionProvider } from 'src/llm/openaiProvider';
import type { ConvertedNote, MarkdownStreamHandler } from 'src/types';

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

jest.mock('src/utils/pngScaler', () => ({
  scalePngBufferToDataUrl: jest.fn(async () => 'data:image/png;base64,AAA'),
}));

const note: ConvertedNote = {
  source: {
    id: 'note-1',
    sourceId: 'fs',
    format: 'image',
    filePath: '/vault/image.png',
    basename: 'Image note',
    inputRoot: '/vault',
    relativeFolder: '.',
  },
  pages: [{ pageNumber: 1, fileName: 'page-1.png', width: 800, height: 600, data: new TextEncoder().encode('page1') }],
};

const config = {
  apiKey: 'test-key',
  model: 'gpt-4o-mini',
  promptTemplate: 'Summarize',
  imageDetail: 'high' as const,
};

describe('OpenAIVisionProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('throws when missing API key', () => {
    expect(() => new OpenAIVisionProvider({ ...config, apiKey: '' })).toThrow('OpenAI API key is missing.');
  });

  it('returns trimmed content from completion', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: ' result ' } }],
    });
    const provider = new OpenAIVisionProvider(config);
    await expect(provider.generateMarkdown(note, 512)).resolves.toBe('result');
  });

  it('throws when no content present', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
    const provider = new OpenAIVisionProvider(config);
    await expect(provider.generateMarkdown(note, 256)).rejects.toThrow('OpenAI did not return any content.');
  });

	it('throws when the API returns no choices at all', async () => {
		mockCreate.mockResolvedValueOnce({ choices: [] });
		const provider = new OpenAIVisionProvider(config);
		await expect(provider.generateMarkdown(note, 512)).rejects.toThrow('OpenAI did not return any content.');
	});

  it('streams chunks via handler', async () => {
    async function* chunkStream() {
      yield { choices: [{ delta: { content: 'first' } }] } as ChatCompletionChunk;
      yield { choices: [{ delta: { content: 'second' } }] } as ChatCompletionChunk;
    }
    mockCreate.mockResolvedValueOnce(chunkStream());
    const provider = new OpenAIVisionProvider(config);
    const handler: jest.MockedFunction<MarkdownStreamHandler> = jest.fn();
    await provider.streamMarkdown(note, 400, handler);
    expect(handler).toHaveBeenNthCalledWith(1, 'first');
    expect(handler).toHaveBeenNthCalledWith(2, 'second');
  });

	it('ignores stream chunks without delta content', async () => {
		async function* emptyStream() {
			yield { choices: [] } as ChatCompletionChunk;
		}
		mockCreate.mockResolvedValueOnce(emptyStream());
		const provider = new OpenAIVisionProvider(config);
		const handler: jest.MockedFunction<MarkdownStreamHandler> = jest.fn();
		await provider.streamMarkdown(note, 300, handler);
		expect(handler).not.toHaveBeenCalled();
	});
});
