export function withField(
  owner: object,
  key: string,
  value: unknown,
): undefined {
  Reflect.set(owner, key, value);
  return undefined;
}

// Interface: the reason the runtime's own JSON parser gives for refusing
// `text`, taken from a call of its own so a test does not copy the wording.
export function reasonJsonRefuses(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error(`JSON.parse read ${text}.`);
}
