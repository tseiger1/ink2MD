import { Buffer } from 'buffer';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { buildVisionMessage, emitStreamContent } from 'src/llm/openaiProvider';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { ConvertedNote, MarkdownStreamHandler } from 'src/types';
import { scalePngBufferToDataUrl } from 'src/utils/pngScaler';

jest.mock('src/utils/pngScaler', () => ({
  scalePngBufferToDataUrl: jest.fn(async (data: Buffer, maxWidth: number) => `scaled:${data.toString('hex')}:${maxWidth}`),
}));

const scaleMock = scalePngBufferToDataUrl as jest.MockedFunction<typeof scalePngBufferToDataUrl>;

describe('buildVisionMessage', () => {
  const note: ConvertedNote = {
    source: {
      id: 'note',
      sourceId: 'filesystem',
      format: 'image',
      filePath: '/vault/page.png',
      basename: 'My Note',
      inputRoot: '/vault',
      relativeFolder: '.',
    },
    pages: [
      { pageNumber: 1, fileName: 'page-1.png', width: 800, height: 600, data: Buffer.from('page1') },
      { pageNumber: 2, fileName: 'page-2.png', width: 800, height: 600, data: Buffer.from('page2') },
    ],
  };

  beforeEach(() => {
    scaleMock.mockClear();
  });

  it('builds a text prompt followed by image URLs with the specified detail level', async () => {
    const message = await buildVisionMessage(note, 'Summarize this note.', 512, 'high');

    expect(message[0]).toEqual({ type: 'text', text: 'Summarize this note.\nTitle: My Note' });
    expect(message[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'scaled:7061676531:512', detail: 'high' },
    });
    expect(message[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'scaled:7061676532:512', detail: 'high' },
    });
    expect(scaleMock).toHaveBeenCalledTimes(2);
  });

  it('omits image entries when the note has no pages', async () => {
    const emptyNote = { ...note, pages: [] };
    const message = await buildVisionMessage(emptyNote, 'Do something', 256, 'low');

    expect(message).toEqual([{ type: 'text', text: 'Do something\nTitle: My Note' }]);
    expect(scaleMock).not.toHaveBeenCalled();
  });
});

describe('emitStreamContent', () => {
  it('handles strings, arrays, and ignores empty parts', async () => {
    const handler: jest.MockedFunction<MarkdownStreamHandler> = jest.fn();

    await emitStreamContent('chunk-one', handler);
		const mixedParts: ChatCompletionContentPart[] = [
	      { type: 'text', text: 'chunk-two' },
	      { type: 'text', text: '' },
		];
	    await emitStreamContent(mixedParts, handler);
	    await emitStreamContent('chunk-three', handler);
	    await emitStreamContent(null, handler);

	    expect(handler).toHaveBeenCalledTimes(3);
	    expect(handler).toHaveBeenNthCalledWith(1, 'chunk-one');
	    expect(handler).toHaveBeenNthCalledWith(2, 'chunk-two');
	    expect(handler).toHaveBeenNthCalledWith(3, 'chunk-three');
  });
});
