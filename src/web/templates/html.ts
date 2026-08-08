/**
 * Shared HTML templating helpers. `html` is a tagged template that escapes
 * every interpolated value by default — wrap trusted markup in `raw()` to
 * include it verbatim. Arrays are joined with each element escaped (or kept
 * raw if wrapped).
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class RawHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

function render(value: unknown): string {
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return out;
}
