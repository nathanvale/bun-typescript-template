export function withField(
  owner: object,
  key: string,
  value: unknown,
): undefined {
  Reflect.set(owner, key, value);
  return undefined;
}

export function reasonJsonRefuses(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error(`JSON.parse read ${text}.`);
}
