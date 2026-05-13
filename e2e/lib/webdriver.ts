import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function elementId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = v[ELEMENT_KEY] ?? v.ELEMENT;
  return typeof id === 'string' ? id : null;
}

async function request(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.value?.message ?? data?.message ?? text;
    throw new Error(`${method} ${path} failed (${res.status}): ${msg}`);
  }
  return data;
}

export function log(prefix: string, message: string): void {
  console.log(`[${prefix}] ${message}`);
}

export async function jpost(path: string, body: unknown): Promise<any> {
  return request('POST', path, body);
}

export async function jget(path: string): Promise<any> {
  return request('GET', path);
}

export async function jdel(path: string): Promise<any> {
  return request('DELETE', path);
}

export async function createSession(app: string): Promise<string> {
  const res = await jpost('/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'wry',
        'tauri:options': { application: app },
      },
    },
  });
  const sid = res?.value?.sessionId;
  if (typeof sid !== 'string') {
    throw new Error(`WebDriver session response did not contain sessionId: ${JSON.stringify(res)}`);
  }
  return sid;
}

export async function deleteSession(sid: string): Promise<void> {
  await jdel(`/session/${sid}`);
}

export async function execScript<T = any>(sid: string, script: string, args: unknown[] = []): Promise<T> {
  const res = await jpost(`/session/${sid}/execute/sync`, { script, args });
  return res.value as T;
}

export async function execAsync<T = any>(sid: string, script: string, args: unknown[] = []): Promise<T> {
  const res = await jpost(`/session/${sid}/execute/async`, { script, args });
  return res.value as T;
}

export async function findElement(sid: string, selector: string): Promise<string | null> {
  try {
    const res = await jpost(`/session/${sid}/element`, {
      using: 'css selector',
      value: selector,
    });
    return elementId(res.value);
  } catch (e) {
    if (String(e).includes('no such element') || String(e).includes('(404)')) return null;
    throw e;
  }
}

export async function findElements(sid: string, selector: string): Promise<string[]> {
  const res = await jpost(`/session/${sid}/elements`, {
    using: 'css selector',
    value: selector,
  });
  const values = Array.isArray(res.value) ? (res.value as unknown[]) : [];
  return values.map(elementId).filter((id): id is string => Boolean(id));
}

export async function elText(sid: string, eid: string): Promise<string> {
  const res = await jget(`/session/${sid}/element/${eid}/text`);
  return String(res.value ?? '');
}

export async function elAttr(sid: string, eid: string, name: string): Promise<string | null> {
  const res = await jget(`/session/${sid}/element/${eid}/attribute/${encodeURIComponent(name)}`);
  return res.value == null ? null : String(res.value);
}

export async function elClick(sid: string, eid: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/click`, {});
}

export async function elClear(sid: string, eid: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/clear`, {});
}

export async function elType(sid: string, eid: string, text: string): Promise<void> {
  await jpost(`/session/${sid}/element/${eid}/value`, {
    text,
    value: Array.from(text),
  });
}

export async function screenshot(sid: string, dest: string, prefix = 'webdriver'): Promise<void> {
  const res = await jget(`/session/${sid}/screenshot`);
  if (typeof res.value !== 'string') throw new Error('screenshot endpoint returned no base64 payload');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(res.value, 'base64'));
  log(prefix, `screenshot -> ${dest}`);
}

export async function takeElementScreenshot(sid: string, eid: string): Promise<Buffer | null> {
  const res = await jget(`/session/${sid}/element/${eid}/screenshot`);
  return typeof res.value === 'string' ? Buffer.from(res.value, 'base64') : null;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      if (value !== null && value !== undefined && value !== false) return value as T;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.${suffix}`);
}
