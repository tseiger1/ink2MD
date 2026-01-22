import { MarkdownGenerationContext } from '../types';

export function buildMarkdown({ note, llmMarkdown, imageEmbeds }: MarkdownGenerationContext): string {
  const frontMatter = [
    '---',
    `source: ${note.source.filePath}`,
    `imported: ${new Date().toISOString()}`,
    `pages: ${note.pages.length}`,
    `format: ${note.source.format}`,
    '---',
  ].join('\n');

  const gallery = imageEmbeds
    .map(({ path, width }, index) => {
      const widthAttr = width ? ` width=\"${Math.round(width)}\"` : '';
      return `<img src=\"${path}\" alt=\"Page ${index + 1}\"${widthAttr} />`;
    })
    .join('\n\n');

  return [
    frontMatter,
    '',
    llmMarkdown.trim(),
    '',
    '## Pages',
    gallery,
  ]
    .filter(Boolean)
    .join('\n\n');
}
