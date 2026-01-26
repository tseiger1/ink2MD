import { buildFrontMatter, buildMarkdown, buildPagesSection } from 'src/markdown/generator';
import { ConvertedNote, ImageEmbed, MarkdownGenerationContext } from 'src/types';

const baseNote: ConvertedNote = {
  source: {
    id: 'source-1',
    sourceId: 'filesystem',
    format: 'pdf',
    filePath: '/vault/imports/handwriting.pdf',
    basename: 'handwriting',
    inputRoot: '/vault/imports',
    relativeFolder: 'imports',
  },
  pages: [
    { pageNumber: 1, fileName: 'page-1.png', width: 1280, height: 720, data: Buffer.from('') },
    { pageNumber: 2, fileName: 'page-2.png', width: 1280, height: 720, data: Buffer.from('') },
  ],
};

describe('buildFrontMatter', () => {
  it('produces a deterministic YAML block that captures metadata about the note', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-07-04T12:34:56.000Z'));

    expect(buildFrontMatter(baseNote)).toBe(
      ['---', 'source: /vault/imports/handwriting.pdf', 'imported: 2024-07-04T12:34:56.000Z', 'pages: 2', 'format: pdf', '---'].join('\n'),
    );

    jest.useRealTimers();
  });
});

describe('buildPagesSection', () => {
  it('renders a gallery with rounded widths and sequential alt text', () => {
    const embeds: ImageEmbed[] = [
      { path: 'attachments/page-1.png', width: 402.7 },
      { path: 'attachments/page-2.png', width: 0 },
    ];

    expect(buildPagesSection(embeds)).toBe(
      '## Pages\n\n<img src="attachments/page-1.png" alt="Page 1" width="403" />\n\n<img src="attachments/page-2.png" alt="Page 2" />',
    );
  });

  it('still returns the section header when there are zero embeds', () => {
    expect(buildPagesSection([])).toBe('## Pages');
  });
});

describe('buildMarkdown', () => {
  it('stitches together the front matter, trimmed LLM output, and the gallery', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-02-29T00:00:00.000Z'));

    const context: MarkdownGenerationContext = {
      note: baseNote,
      llmMarkdown: '\nSummary from model.  ',
      imageEmbeds: [{ path: 'img/page-1.png', width: 512 }],
    };

    expect(buildMarkdown(context)).toBe(
      [
        '---',
        'source: /vault/imports/handwriting.pdf',
        'imported: 2024-02-29T00:00:00.000Z',
        'pages: 2',
        'format: pdf',
        '---',
        '',
        'Summary from model.',
        '',
        '## Pages',
        '',
        '<img src="img/page-1.png" alt="Page 1" width="512" />',
      ].join('\n'),
    );

    jest.useRealTimers();
  });

  it('omits empty LLM output but still includes the pages section header', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const context: MarkdownGenerationContext = {
      note: baseNote,
      llmMarkdown: '   ',
      imageEmbeds: [],
    };

    expect(buildMarkdown(context)).toBe(
      [
        '---',
        'source: /vault/imports/handwriting.pdf',
        'imported: 2025-01-01T00:00:00.000Z',
        'pages: 2',
        'format: pdf',
        '---',
        '',
        '## Pages',
      ].join('\n'),
    );

    jest.useRealTimers();
  });
});
