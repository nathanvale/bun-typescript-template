import { afterEach, spyOn } from "bun:test";

export function streamWrites() {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  return (stream: NodeJS.WriteStream): (() => string) => {
    const spy = spyOn(stream, "write").mockImplementation(() => true);
    spies.push(spy);
    return () => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
  };
}
