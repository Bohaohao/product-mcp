export interface ChromePage {
  id: number;
  url: string;
  selected: boolean;
  rawText?: string;
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
    const match = line.match(/^\s*(?:[-*]\s*)?(\d+):\s+(.+?)\s*$/);
    if (!match) continue;
    const rawPageText = match[2].replace(/\s*\[selected\]\s*/gi, ' ').trim();
    pages.push({
      id: Number(match[1]),
      url: extractPageUrl(rawPageText),
      selected: /\[selected\]/i.test(match[2]),
      rawText: line.trim()
    });
  }

  return pages;
}
