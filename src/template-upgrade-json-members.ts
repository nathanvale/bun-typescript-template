const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\/\/.*|\/\*[\s\S]*?\*\/|[[\]{}]/g;
const CONFLICT_HUNK =
  /^<{7} ours\r?\n([\s\S]*?)(?:^\|{7} old\r?\n[\s\S]*?)?^={7}\r?\n([\s\S]*?)^>{7} new(?:\r?\n|$)/gm;

function repeatsMember(text: string): boolean {
  const scopes: Set<string>[] = [];
  for (const [token, name, colon] of text.matchAll(JSON_TOKEN)) {
    const names = scopes.at(-1);
    if (name !== undefined && colon !== undefined) {
      if (names?.has(name)) {
        return true;
      }
      names?.add(name);
    } else if (token === "{" || token === "[") {
      scopes.push(new Set());
    } else if (token === "}" || token === "]") {
      scopes.pop();
    }
  }
  return false;
}

export function mergeDuplicatesMember(mergedText: string): boolean {
  return (
    repeatsMember(mergedText.replace(CONFLICT_HUNK, "$1")) ||
    repeatsMember(mergedText.replace(CONFLICT_HUNK, "$2"))
  );
}
