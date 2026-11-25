const OPTIONAL_HEALTH_CATEGORIES = new Set([
  "churn+complexity",
  "churn+complexity (cross-package)",
  "circular dep",
  "circular dependency",
  "complexity",
  "coupling",
  "dead code",
  "hidden coupling",
  "high impact",
  "untested risk",
]);

export function keyJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(keyJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, keyJsonValue(item)]),
    );
  }
  return value;
}

export function isOptionalHealthKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  return OPTIONAL_HEALTH_CATEGORIES.has(value.slice(separator + 1));
}

function countOptionalKeys(items: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!isOptionalHealthKey(item) || typeof item !== "string") continue;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function hasOptionalAdditions(
  beforeValue: unknown,
  afterValue: unknown,
): boolean {
  if (
    !Array.isArray(afterValue) ||
    (beforeValue !== undefined && !Array.isArray(beforeValue))
  ) {
    return false;
  }
  const beforeCounts = countOptionalKeys(beforeValue ?? []);
  for (const [key, count] of countOptionalKeys(afterValue)) {
    if (count > (beforeCounts.get(key) ?? 0)) {
      return true;
    }
  }
  return false;
}

export function keepBaseHealthKeys(
  beforeObj: Readonly<Record<string, unknown>>,
  afterObj: Readonly<Record<string, unknown>>,
):
  | {
      readonly restored: Readonly<Record<string, unknown>>;
      readonly equalToBefore: boolean;
    }
  | undefined {
  if (beforeObj.kind !== "health" || afterObj.kind !== "health") {
    return undefined;
  }
  const hasBeforeKey = Object.hasOwn(beforeObj, "target_keys");
  const beforeValue = hasBeforeKey ? beforeObj.target_keys : undefined;
  const afterValue = Object.hasOwn(afterObj, "target_keys")
    ? afterObj.target_keys
    : undefined;
  if (!hasOptionalAdditions(beforeValue, afterValue)) {
    return undefined;
  }
  const restored = Object.fromEntries(
    Object.entries(afterObj).flatMap(([key, value]) =>
      key !== "target_keys"
        ? [[key, value]]
        : hasBeforeKey
          ? [[key, beforeValue]]
          : [],
    ),
  );
  return {
    restored,
    equalToBefore:
      JSON.stringify(keyJsonValue(restored)) ===
      JSON.stringify(keyJsonValue(beforeObj)),
  };
}
