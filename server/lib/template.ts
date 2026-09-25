/**
 * Message personalization.
 *
 *   Hi {{first_name|there}}, your {{city}} store is open till {{closing_time}}.
 *
 * `{{name}}` looks the variable up (case-insensitive, spaces/dashes treated as underscores);
 * `{{name|fallback}}` uses the fallback when the value is missing or blank. Unknown variables with
 * no fallback render as an empty string and are reported in `missing`, so the UI can warn before a
 * campaign goes out with a hole in it.
 */
const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

export interface RenderResult {
  text: string;
  missing: string[];
}

export function normalizeVarName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(attr|attributes|contact)\./, '')
    .replace(/[\s-]+/g, '_');
}

export function renderTemplate(template: string, vars: Record<string, unknown>): RenderResult {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
    lookup.set(normalizeVarName(key), text);
  }
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_match, rawName: string, fallback: string | undefined) => {
    const name = normalizeVarName(rawName);
    const value = lookup.get(name);
    if (value !== undefined && value.trim() !== '') return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
  return { text, missing: [...missing] };
}

/** Variable names referenced by a template, for the editor's "used variables" hint. */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) names.add(normalizeVarName(match[1]));
  return [...names];
}

export interface ContactVarsInput {
  name: string | null;
  phone: string;
  email: string | null;
  attributes: Record<string, unknown>;
}

/** The variables every message can use. Attributes cannot shadow the built-ins. */
export function contactVariables(contact: ContactVarsInput, extra: Record<string, string> = {}): Record<string, unknown> {
  const name = (contact.name ?? '').trim();
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  return {
    ...contact.attributes,
    ...extra,
    name,
    full_name: name,
    first_name: first ?? '',
    last_name: rest.join(' '),
    phone: `+${contact.phone}`,
    email: contact.email ?? '',
  };
}
