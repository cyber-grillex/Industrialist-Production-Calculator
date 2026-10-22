/**
 * Share-link codec for simple mode. The whole calculation lives in the URL hash,
 * so a link needs no server: `https://host/#s=<base64url(JSON)>`.
 */

export interface SimpleState {
  /** target product id */
  productId: string;
  /** target rate as typed by the user */
  rate: number;
  /** unit of `rate`: per second or per minute */
  unit: 's' | 'm';
  /** productId -> chosen recipeId */
  choices: Record<string, string>;
  /** products supplied from outside */
  external: string[];
  /** recipeId -> numeric recipe settings (e.g. steam temperature) */
  settings: Record<string, Record<string, number>>;
}

const VERSION = 1;
const HASH_KEY = 's=';

export const DEFAULT_STATE: SimpleState = {
  productId: 'p_purple_gold_ingot',
  rate: 1,
  unit: 's',
  choices: {},
  external: [],
  settings: {},
};

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeState(state: SimpleState): string {
  return toBase64Url(JSON.stringify({ v: VERSION, ...state }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns null when the payload is missing, corrupt or from an unknown version. */
export function decodeState(encoded: string): SimpleState | null {
  try {
    const raw: unknown = JSON.parse(fromBase64Url(encoded));
    if (!isRecord(raw) || raw.v !== VERSION) return null;
    if (typeof raw.productId !== 'string' || raw.productId === '') return null;
    if (typeof raw.rate !== 'number' || !Number.isFinite(raw.rate) || raw.rate <= 0) return null;
    const choices: Record<string, string> = {};
    if (isRecord(raw.choices)) {
      for (const [k, v] of Object.entries(raw.choices)) if (typeof v === 'string') choices[k] = v;
    }
    const settings: Record<string, Record<string, number>> = {};
    if (isRecord(raw.settings)) {
      for (const [recipeId, values] of Object.entries(raw.settings)) {
        if (!isRecord(values)) continue;
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(values)) {
          if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
        }
        settings[recipeId] = clean;
      }
    }
    return {
      productId: raw.productId,
      rate: raw.rate,
      unit: raw.unit === 'm' ? 'm' : 's',
      choices,
      external: Array.isArray(raw.external)
        ? raw.external.filter((x): x is string => typeof x === 'string')
        : [],
      settings,
    };
  } catch {
    return null;
  }
}

export function buildShareUrl(state: SimpleState, base: string): string {
  const withoutHash = base.split('#')[0];
  return `${withoutHash}#${HASH_KEY}${encodeState(state)}`;
}

export function readStateFromHash(hash: string): SimpleState | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!trimmed.startsWith(HASH_KEY)) return null;
  return decodeState(trimmed.slice(HASH_KEY.length));
}
