/**
 * Android features, exposed by the app over a Unix socket (PIDROID_BRIDGE_SOCKET).
 * The Kotlin side owns the capability list and the access checks; this file only wraps calls as tools.
 * A call that needs a permission the user hasn't granted fails with code "needs_permission".
 * After editing, call reload_extensions.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

class BridgeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** One request per connection: send a JSON line, read the JSON line back. */
function call(method: string, args: Record<string, unknown> = {}): Promise<any> {
  const path = process.env.PIDROID_BRIDGE_SOCKET;
  if (!path) return Promise.reject(new BridgeError("Not running inside the Pidroid app", "unavailable"));
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new BridgeError("Android bridge timed out", "timeout")), 15_000);
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

const batteryStatus = defineTool({
  name: "battery_status",
  description: "Battery level, charging state, power source and temperature of the phone.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    api.output(JSON.stringify(await call("battery.get")));
    return {};
  },
});

const notify = defineTool({
  name: "notify_user",
  description:
    "Post an Android notification to the user, even when the app is in the background. " +
    "Passing the same id again replaces the earlier notification. Fails with code needs_permission if notifications are blocked.",
  parameters: Type.Object({
    title: Type.String(),
    body: Type.Optional(Type.String()),
    id: Type.Optional(Type.Integer({ description: "Reuse to update a previous notification" })),
  }),
  // Posting twice would notify twice, so it must not silently re-run when a run is replayed.
  replay: "unsafe",
  execute: async (args, api) => {
    const res = await call("notification.post", args);
    api.output(`Notification posted (id ${res.id})`);
    return {};
  },
});

export default defineExtension({
  name: "android",
  tools: [batteryStatus, notify],
});
