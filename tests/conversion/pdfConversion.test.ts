import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NoteSource } from 'src/types';

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const getDocument = jest.fn();
  return {
    getDocument,
    GlobalWorkerOptions: { workerSrc: '' },
  };
});

type MockCanvasContext = CanvasRenderingContext2D & {
	drawImage: jest.Mock;
};

type MockCanvas = {
	width: number;
	height: number;
	getContext: jest.MockedFunction<() => MockCanvasContext | null>;
	toDataURL: jest.MockedFunction<() => string>;
};

type MockPdfPage = {
	pageNumber: number;
	render: jest.MockedFunction<() => { promise: Promise<void> }>;
	getViewport: jest.MockedFunction<({ scale }: { scale: number }) => { width: number; height: number }>;
	cleanup: jest.MockedFunction<() => void>;
};

type MockPdfDocument = {
	numPages: number;
	getPage: jest.MockedFunction<(index: number) => Promise<MockPdfPage>>;
	destroy: jest.MockedFunction<() => Promise<void>>;
};

type PdfLoadingTask = ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>;

type MockPdfLoadingTask = {
	promise: Promise<MockPdfDocument>;
	onProgress?: jest.Mock;
	destroy?: jest.Mock;
};

let convertPdfSource: typeof import('src/conversion/pdfConversion')['convertPdfSource'];
let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const source: NoteSource = {
  id: 'pdf-source',
  sourceId: 'filesystem',
  format: 'pdf',
  filePath: '/vault/imports/note.pdf',
  basename: 'note',
  inputRoot: '/vault/imports',
  relativeFolder: 'imports',
};

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalBlob = (globalThis as typeof globalThis & { Blob?: typeof Blob }).Blob;
const builtinBlob =
	typeof Blob !== 'undefined'
		? Blob
		: (class PlaceholderBlob {
			constructor(_parts?: BlobPart[], _options?: BlobPropertyBag) {}
		} as unknown as typeof Blob);
const originalURL = globalThis.URL;

beforeAll(async () => {
	const BlobBase = originalBlob ?? builtinBlob;
	(globalThis as typeof globalThis & { Blob?: typeof Blob }).Blob = class MockBlob extends BlobBase {
		constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
			super(parts ?? [], options);
		}
	};
	globalThis.URL = {
		createObjectURL: jest.fn(() => 'blob:mock'),
		revokeObjectURL: jest.fn(),
	} as unknown as typeof URL;
	globalThis.window = {
		addEventListener: jest.fn(),
	} as unknown as Window & typeof globalThis;

  ({ convertPdfSource } = await import('src/conversion/pdfConversion'));
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
});

const createPage = (pageNumber: number): MockPdfPage => {
	const render = jest.fn(() => ({ promise: Promise.resolve() }));
	const getViewport = jest.fn(({ scale }: { scale: number }) => ({
		width: 1200 * scale,
		height: 800 * scale,
	}));
	const cleanup = jest.fn();
	return { pageNumber, render, getViewport, cleanup };
};

describe('convertPdfSource', () => {
  const readFileMock = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
  let getDocumentMock: jest.MockedFunction<typeof pdfjsLib.getDocument> | null = null;
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    getDocumentMock = pdfjsLib.getDocument as jest.MockedFunction<typeof pdfjsLib.getDocument>;
    const page1 = createPage(1);
    const page2 = createPage(2);
    const pdf: MockPdfDocument = {
      numPages: 2,
      getPage: jest.fn(async (index: number) => (index === 1 ? page1 : page2)),
      destroy: jest.fn(async () => {}),
    };
    const loadingTask: MockPdfLoadingTask = { promise: Promise.resolve(pdf) };
    getDocumentMock.mockReturnValue(loadingTask as unknown as PdfLoadingTask);
    readFileMock.mockResolvedValue(Buffer.from('pdf-bytes'));

    const canvases: MockCanvas[] = [
      createCanvas('page-1'),
      createCanvas('page-2'),
    ];
    globalThis.document = {
      createElement: jest.fn(() => canvases.shift()!),
    } as unknown as Document;
    consoleErrorSpy.mockClear();
  });

afterEach(() => {
	readFileMock.mockReset();
	getDocumentMock?.mockReset();
	globalThis.document = originalDocument;
});

afterAll(() => {
	globalThis.document = originalDocument;
	globalThis.window = originalWindow;
	(globalThis as typeof globalThis & { Blob?: typeof Blob }).Blob = originalBlob;
	globalThis.URL = originalURL;
	consoleErrorSpy.mockRestore();
});

  it('converts each PDF page into a PNG buffer respecting max width and dpi', async () => {
    const result = await convertPdfSource(source, 600, 144);
    expect(result?.pages).toHaveLength(2);
    expect(result?.pages[0]).toMatchObject({
      pageNumber: 1,
      fileName: 'note-page-1.png',
      width: 600,
      height: 400,
    });
    expect(result?.pages[1]).toMatchObject({
      pageNumber: 2,
      fileName: 'note-page-2.png',
      width: 600,
      height: 400,
    });
    expect(result?.pages[0]?.data.toString()).toBe('page-1');
    expect(result?.pages[1]?.data.toString()).toBe('page-2');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('returns null and logs when the canvas context is unavailable', async () => {
    globalThis.document = {
      createElement: jest.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => null,
      })),
    } as unknown as Document;

    const result = await convertPdfSource(source, 600, 144);
    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to convert PDF'), expect.any(Error));
  });

  it('returns null when pdf.js fails to load the document', async () => {
    const failingTask: MockPdfLoadingTask = {
      promise: Promise.reject(new Error('load error')),
    };
    getDocumentMock.mockReturnValueOnce(failingTask as unknown as PdfLoadingTask);

    const result = await convertPdfSource(source, 600, 144);
    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

function createCanvas(label: string): MockCanvas {
	const context: MockCanvasContext = {
		drawImage: jest.fn(),
	} as unknown as MockCanvasContext;
	return {
		width: 0,
		height: 0,
		getContext: jest.fn(() => context),
		toDataURL: jest.fn(() => `data:image/png;base64,${Buffer.from(label).toString('base64')}`),
	};
}
