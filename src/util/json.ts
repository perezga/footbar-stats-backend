/** JSON.parse that yields null on corrupt input instead of throwing. */
export function tryParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
