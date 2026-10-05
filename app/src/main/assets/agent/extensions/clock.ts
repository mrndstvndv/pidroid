/**
 * Example extension, and a template for the agent's own: default-export defineExtension(...).
 * After editing or adding a file here, call the reload_extensions tool; no restart is needed.
 * Imports resolve to the same pi-durable / pi-ai instances the server uses.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const currentTime = defineTool({
  name: "current_time",
  description: "Current date and time on the phone, with its time zone.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    api.output(`${new Date().toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
    return {};
  },
});

export default defineExtension({
  name: "clock",
  tools: [currentTime],
});
