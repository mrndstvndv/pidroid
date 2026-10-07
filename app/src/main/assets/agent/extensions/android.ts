/**
 * Android features, exposed by the app over a Unix socket (PIDROID_BRIDGE_SOCKET).
 * The Kotlin side owns the capability list and the access checks; this file only wraps calls as tools.
 * A call that needs a permission the user hasn't granted fails with code "needs_permission".
 *
 * The socket client itself is ../bridge.ts, shared with the harness, which posts its own notification
 * when a run ends unattended. That helper is imported, not inlined, so there is only one copy of the
 * wire protocol -- and unlike this file it is not hot-swapped: restart_server after changing it.
 * After editing this file, call reload_extensions.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bridgeCall as call } from "../bridge.ts";

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
    "Passing the same id again replaces the earlier notification. Fails with code needs_permission if notifications are blocked. " +
    "The harness posts its own notification when a run ends while the app is off screen, so do not use this tool to announce that you are done or to report progress.",
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
