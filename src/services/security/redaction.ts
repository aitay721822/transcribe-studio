import type { Settings } from '../../domain/models';
import { record } from '../../domain/value';

const MASK = '••••••••';
const sensitive =
  /api.?key|token|secret|password|passwd|authorization|credential|cookie|private.?key/i;

/** Only configured credentials and recognizable credential forms are removed, never whole traces. */
export function credentialRedactor(
  settings: Partial<Settings> = {},
  environment: NodeJS.ProcessEnv = process.env,
  additional?: unknown
) {
  const values = new Set<string>();

  function remember(value: unknown) {
    if (typeof value !== 'string' || value.length < 4 || value === MASK) return;
    values.add(value);
    values.add(encodeURIComponent(value));
    values.add(JSON.stringify(value).slice(1, -1));
    if (/^Bearer\s+/i.test(value)) remember(value.replace(/^Bearer\s+/i, ''));
  }

  function inspect(value: unknown, all = false) {
    if (typeof value === 'string') {
      if (all) remember(value);
      if (/^(?:https?|wss?):\/\//i.test(value)) {
        try {
          const url = new URL(value);
          remember(decodeURIComponent(url.username));
          remember(decodeURIComponent(url.password));
          for (const [key, item] of url.searchParams) if (sensitive.test(key)) remember(item);
        } catch {
          // Invalid draft URLs are validated by the connection layer.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        inspect(item, all);
        if (typeof item !== 'string') continue;
        const flag = item.match(/^--?([^=]+)(?:=(.*))?$/);
        if (flag && sensitive.test(flag[1])) remember(flag[2] ?? value[index + 1]);
      }
      return;
    }
    for (const [key, item] of Object.entries(record(value)))
      inspect(item, all || sensitive.test(key) || key === 'headers' || key === 'fileHeaders');
  }

  inspect(settings);
  remember(settings.llm?.claudeKey);
  inspect(additional);
  for (const [key, value] of Object.entries(environment)) if (sensitive.test(key)) remember(value);
  const secrets = [...values].sort((a, b) => b.length - a.length);

  function text(value: string) {
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, MASK);
    return result
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, `Bearer ${MASK}`)
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, MASK)
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^\s&#"']+/gi,
        `$1${MASK}`
      )
      .replace(/((?:https?|wss?):\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MASK}@`);
  }

  function value(input: unknown): unknown {
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input === null || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [
        key,
        sensitive.test(key) && typeof item === 'string' && item ? MASK : value(item),
      ])
    );
  }

  return { text, value };
}
