/**
 * The Android bridge: the app's Kotlin host listens on a Unix socket (PIDROID_BRIDGE_SOCKET) and
 * answers one JSON request per connection. The host owns the capability list and the access checks,
 * so a call that needs a permission the user has not granted comes back as code "needs_permission"
 * rather than as a connection failure.
 *
 * It lives here, next to server.ts, rather than inside extensions/android.ts, because two callers
 * need the same wire: the harness (which posts a notification when a run ends unattended) and that
 * extension (which exposes the bridge as tools). Extensions are switchable and hot-swapped, and a
 * notification the harness depends on must not disappear with one of them.
 */

/** A call the host refused or could not answer; `code` is the host's own reason. */
export class BridgeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** How long the host gets to answer before the call is abandoned. */
const BRIDGE_TIMEOUT_MS = 15_000;

/** Whether this process can reach the host at all: it cannot when the server runs outside the app. */
export function bridgeAvailable(): boolean {
  return Boolean(process.env.PIDROID_BRIDGE_SOCKET);
}

/** One request per connection: send a JSON line, read the JSON line back. */
export function bridgeCall(method: string, args: Record<string, unknown> = {}): Promise<any> {
  const path = process.env.PIDROID_BRIDGE_SOCKET;
  if (!path) return Promise.reject(new BridgeError("Not running inside the Pidroid app", "unavailable"));
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new BridgeError("Android bridge timed out", "timeout")), BRIDGE_TIMEOUT_MS);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    Bun.connect({
      unix: path,
      socket: {
        open(sock) {
          sock.write(JSON.stringify({ method, args }) + "\n");
        },
        data(_sock, chunk) {
          buf += chunk.toString();
        },
        close() {
          try {
            const res = JSON.parse(buf);
            done(() => (res.ok ? resolve(res.result) : reject(new BridgeError(res.error, res.code))));
          } catch {
            done(() => reject(new BridgeError("Bad reply from Android bridge", "internal")));
          }
        },
        error(_sock, err) {
          done(() => reject(new BridgeError(err.message, "unavailable")));
        },
        connectError(_sock, err) {
          done(() => reject(new BridgeError(err.message, "unavailable")));
        },
      },
    }).catch((err) => done(() => reject(new BridgeError(String(err?.message ?? err), "unavailable"))));
  });
}
