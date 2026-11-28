import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KernelPin, kernelPinFile, readKernelPin } from "./kernel-pin.ts";
import { pinBranchCommitHeld, PinRefusal, verifyPin } from "./pin-move.ts";

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return found;
}

export function verifyPinPlaces(root: string, pin: KernelPin): void {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath))
    throw new PinRefusal(
      "pin_places_disagree",
      `package.json is missing while ${kernelPinFile} pins ${pin.commit}.`,
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new PinRefusal(
      "pin_places_disagree",
      `package.json could not be parsed while ${kernelPinFile} pins ${pin.commit}.`,
    );
  }
  const spec = ownValue(ownValue(manifest, "dependencies"), "agent-cli-kernel");
  const packageCommit =
    typeof spec === "string" ? /#([0-9a-f]{40})$/.exec(spec)?.[1] : undefined;
  if (packageCommit !== pin.commit)
    throw new PinRefusal(
      "pin_places_disagree",
      `package.json pins agent-cli-kernel at ${packageCommit ?? JSON.stringify(spec)}, while ${kernelPinFile} pins ${pin.commit}.`,
    );
  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath))
    throw new PinRefusal(
      "pin_places_disagree",
      `bun.lock is missing while ${kernelPinFile} pins ${pin.commit}.`,
    );
  const lock = readFileSync(lockPath, "utf8");
  const declared = /"agent-cli-kernel": "[^"\n]*#([0-9a-f]{40})"/.exec(
    lock,
  )?.[1];
  if (declared !== pin.commit)
    throw new PinRefusal(
      "pin_places_disagree",
      `bun.lock declares agent-cli-kernel at ${declared ?? "no full commit"}, while ${kernelPinFile} pins ${pin.commit}.`,
    );
  const resolved =
    /"agent-cli-kernel": \["agent-cli-kernel@[^"\n]*#([0-9a-f]{7,40})"/.exec(
      lock,
    )?.[1];
  if (resolved === undefined || !pin.commit.startsWith(resolved))
    throw new PinRefusal(
      "pin_places_disagree",
      `bun.lock resolves agent-cli-kernel to ${resolved ?? "no record"}, while ${kernelPinFile} pins ${pin.commit}.`,
    );
}

export function verifyKernelPin(root: string, kernel: string): string {
  const pin = readKernelPin(root);
  verifyPinPlaces(root, pin);
  const branchCommit = pinBranchCommitHeld(pin, kernel);
  verifyPin({ repository: kernel, commit: pin.commit }, pin, branchCommit);
  return `Pin verified: ${pin.commit} is reachable from ${branchCommit}, where branch ${pin.branch} points on ${pin.remote}, and has the carry-out commit ${pin.carryOutIdentity} as an ancestor.\n`;
}
