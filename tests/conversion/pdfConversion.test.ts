import { promises as fs } from 'fs';
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

let convertPdfSource: typeof import('src/conversion/pdfConversion')['convertPdfSource'];
let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs');

type MockCanvas = {
  width: number;
  height: number;
  getContext: jest.Mock;
  toDataURL: jest.Mock;
};

const source: NoteSource = {
  id: 'pdf-source',
  sourceId: 'filesystem',
  format: 'pdf',
  filePath: '/vault/imports/note.pdf',
  basename: 'note',
  inputRoot: '/vault/imports',
  relativeFolder: 'imports',
};

const originalDocument = global.document;
const originalWindow = global.window;
const originalBlob = (global as any).Blob;
const originalURL = global.URL;

beforeAll(async () => {
  (global as any).Blob = class {
    constructor(_parts: unknown[], _options?: unknown) {}
  };
  global.URL = {
    createObjectURL: jest.fn(() => 'blob:mock'),
    revokeObjectURL: jest.fn(),
  } as unknown as typeof URL;
  global.window = {
    addEventListener: jest.fn(),
  } as unknown as Window & typeof globalThis;

  ({ convertPdfSource } = await import('src/conversion/pdfConversion'));
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
});

const createPage = (pageNumber: number) => {
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
  let getDocumentMock: jest.MockedFunction<typeof pdfjsLib.getDocument>;
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    getDocumentMock = pdfjsLib.getDocument as jest.MockedFunction<typeof pdfjsLib.getDocument>;
    const page1 = createPage(1);
    const page2 = createPage(2);
    const pdf = {
      numPages: 2,
      getPage: jest.fn(async (index: number) => (index === 1 ? page1 : page2)),
      destroy: jest.fn(async () => {}),
    };
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(pdf) } as any);
    readFileMock.mockResolvedValue(Buffer.from('pdf-bytes'));

    const canvases: MockCanvas[] = [
      createCanvas('page-1'),
      createCanvas('page-2'),
    ];
    global.document = {
      createElement: jest.fn(() => canvases.shift()!),
    } as unknown as Document;
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    readFileMock.mockReset();
    getDocumentMock.mockReset();
    global.document = originalDocument;
  });

  afterAll(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    (global as any).Blob = originalBlob;
    global.URL = originalURL;
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
    global.document = {
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
    getDocumentMock.mockReturnValueOnce({ promise: Promise.reject(new Error('load error')) } as any);

    const result = await convertPdfSource(source, 600, 144);
    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

function createCanvas(label: string): MockCanvas {
  return {
    width: 0,
    height: 0,
    getContext: jest.fn(() => ({})),
    toDataURL: jest.fn(() => `data:image/png;base64,${Buffer.from(label).toString('base64')}`),
  } as unknown as MockCanvas;
}
