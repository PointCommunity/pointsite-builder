import { z } from 'zod';

const INTERNAL_PATH = /^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/;
const RESERVED_ROUTE = /^\/(?:api|admin|builder)(?:\/|$)/;

function containsControlOrBackslash(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '\\' || codePoint < 32 || codePoint === 127;
  });
}

export function isSafeInternalPath(value: string): boolean {
  return INTERNAL_PATH.test(value) && !RESERVED_ROUTE.test(value);
}

export function isSafeHttpsUrl(value: string): boolean {
  if (containsControlOrBackslash(value)) return false;

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function isSafeMailtoUrl(value: string): boolean {
  if (containsControlOrBackslash(value) || !value.startsWith('mailto:')) return false;
  const address = value.slice('mailto:'.length).split('?')[0] ?? '';
  return z.email().safeParse(address).success;
}

export const CanonicalRouteSchema = z
  .string()
  .max(120)
  .refine(isSafeInternalPath, 'Route must be a canonical, lowercase, non-reserved path');

export const SafeHrefSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => isSafeInternalPath(value) || isSafeHttpsUrl(value) || isSafeMailtoUrl(value),
    'Link must be a safe site path, HTTPS URL, or email link',
  );

export const SafeHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine(isSafeHttpsUrl, 'URL must use HTTPS without embedded credentials');
