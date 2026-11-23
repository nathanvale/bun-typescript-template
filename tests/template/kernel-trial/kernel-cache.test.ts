import { describe, expect, test } from "bun:test";
import { kernelCachePath } from "../../../src/kernel-pin.ts";

describe("with neither KERNEL_REPOSITORY nor a sibling repository, Bootstrap and a Template upgrade find the kernel in the kernel cache", () => {
  test("the cache sits at bun-typescript-template/agent-cli-kernel.git under XDG_CACHE_HOME when it is set, and under ~/.cache otherwise", () => {
    expect(
      kernelCachePath({ XDG_CACHE_HOME: "/x/cache", HOME: "/x/home" }),
    ).toBe("/x/cache/bun-typescript-template/agent-cli-kernel.git");
    expect(kernelCachePath({ HOME: "/x/home" })).toBe(
      "/x/home/.cache/bun-typescript-template/agent-cli-kernel.git",
    );
    expect(kernelCachePath({ XDG_CACHE_HOME: "", HOME: "/x/home" })).toBe(
      "/x/home/.cache/bun-typescript-template/agent-cli-kernel.git",
    );
  });
});
