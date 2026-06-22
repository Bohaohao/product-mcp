export interface ChromePage {
  id: number;
  url: string;
  selected: boolean;
}

function extractPageUrl(rawPageText: string): string {
  const text = rawPageText.trim();
  const parenthesizedUrl = text.match(/\((https?:\/\/[^)]+)\)\s*$/);
  if (parenthesizedUrl) return parenthesizedUrl[1].trim();

  const embeddedUrl = text.match(/https?:\/\/[^\s)]+/);
  if (embeddedUrl) return embeddedUrl[0].trim();

  return text;
}

export function parsePages(text: string): ChromePage[] {
  const pages: ChromePage[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d+):\s+(.+?)(\s+\[selected\])?$/);
    if (!match) continue;
    pages.push({
      id: Number(match[1]),
      url: extractPageUrl(match[2]),
      selected: Boolean(match[3])
    });
  }

  return pages;
}
