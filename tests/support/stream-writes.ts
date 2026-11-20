import { afterEach, spyOn } from "bun:test";

// Interface: captures for one test file what an in-process subject writes to
// process.stdout or process.stderr, instead of printing it. Call it at the
// file's top; each capture is undone after its test.
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
