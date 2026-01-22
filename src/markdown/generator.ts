import { MarkdownGenerationContext } from '../types';

export function buildMarkdown({ note, llmMarkdown, imagePaths }: MarkdownGenerationContext): string {
  const frontMatter = [
    '---',
    `source: ${note.source.filePath}`,
    `imported: ${new Date().toISOString()}`,
    `pages: ${note.pages.length}`,
    `format: ${note.source.format}`,
    '---',
  ].join('\n');

  const gallery = imagePaths.map((image) => `![[${image}]]`).join('\n\n');

  return [
    frontMatter,
    '',
    '## Pages',
    gallery,
    '',
    '## AI summary',
    llmMarkdown.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
