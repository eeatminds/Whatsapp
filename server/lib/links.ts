/**
 * URL detection for click tracking. Trailing punctuation that belongs to the sentence rather than
 * the link ("see https://x.com/sale." or "(https://x.com)") is left outside the match.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

function trimTrailing(url: string): string {
  let result = url;
  for (;;) {
    const last = result.at(-1);
    if (!last) return result;
    if ('.,!?;:*_~'.includes(last)) {
      result = result.slice(0, -1);
      continue;
    }
    // Only strip a closing bracket when it is unbalanced inside the URL.
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    if (pairs[last]) {
      const open = result.split(pairs[last]).length - 1;
      const close = result.split(last).length - 1;
      if (close > open) {
        result = result.slice(0, -1);
        continue;
      }
    }
    return result;
  }
}

export function extractUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0]);
    if (url.length > 10) urls.add(url);
  }
  return [...urls];
}

export function replaceUrls(text: string, replace: (url: string) => string | null): string {
  return text.replace(URL_PATTERN, match => {
    const url = trimTrailing(match);
    const suffix = match.slice(url.length);
    const replacement = replace(url);
    return (replacement ?? url) + suffix;
  });
}

/** Link-preview fetchers and crawlers. Their requests are not human clicks. */
const BOT_UA = /(whatsapp|facebookexternalhit|facebot|twitterbot|slackbot|telegrambot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview|curl\/|wget\/|python-requests|headless)/i;

export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return true;
  return BOT_UA.test(userAgent);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
