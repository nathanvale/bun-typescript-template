import { createConnection, type Socket } from "node:net";

const defaultProbeTimeoutMs = 500;

const loopbackSkipReason = "loopback connect refused by sandbox";

const loopbackSkipNotice = `needs-loopback: skipped, ${loopbackSkipReason}`;

function startLoopbackListener() {
  try {
    return Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {
          return;
        },
      },
    });
  } catch {
    return undefined;
  }
}

function probeLoopbackConnect(
  timeoutMs = defaultProbeTimeoutMs,
): Promise<boolean> {
  const server = startLoopbackListener();
  if (!server) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      server.stop(true);
      resolve(allowed);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    try {
      socket = createConnection({ host: "127.0.0.1", port: server.port });
      socket.once("connect", () => {
        finish(true);
      });
      socket.once("error", () => {
        finish(false);
      });
      socket.once("close", () => {
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

export async function shouldSkipLoopback(
  options: {
    readonly probe?: () => Promise<boolean>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly report?: (line: string) => void;
  } = {},
): Promise<boolean> {
  const probe = options.probe ?? probeLoopbackConnect;
  const env = options.env ?? process.env;
  const report =
    options.report ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const allowed = await probe();
  if (allowed) return false;
  if (env.CI === "true") {
    throw new Error(
      `loopback-connect-probe: ${loopbackSkipReason} under CI=true; refusing to skip loopback daemon tests in CI`,
    );
  }
  report(loopbackSkipNotice);
  return true;
}
