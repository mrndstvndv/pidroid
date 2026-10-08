/**
 * save_bundle: snapshot the agent's source files out to shared storage as a tarball.
 *
 * The archiving itself lives in ../bundles.ts, which the Files tab's "Export bundle" button
 * reaches over the same HTTP route. One implementation, so the tree the tab shows and the tarball
 * the tool writes can never disagree.
 *
 * After editing, call reload_extensions. No restart needed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { writeBundle } from "../bundles.ts";

const saveBundle = defineTool({
  name: "save_bundle",
  view: { verb: { one: "saved a bundle", many: "saved {n} bundles" } },
  description:
    "Snapshot every source file of the app to a <name>.tar.gz in /storage/emulated/0/Download so the " +
    "work can be pulled onto a desktop and committed to a real repo. This is the escape hatch: the " +
    "agent's work normally lives only in the app sandbox, where an app update can overwrite it, and " +
    "the local commit journal is a per-turn log with no remote. The archive is always the complete " +
    "tree -- there is no partial mode -- and carries a MANIFEST.json labelling each file against the " +
    "app's shipped baseline (.shipped_manifest.json). Credentials (auth.json), session databases, " +
    "the local .git, scratch directories, generated bundles and the uploads/ directory of attached " +
    "images are always excluded.",
  parameters: Type.Object({
    name: Type.Optional(
      Type.String({ description: "Filename prefix (default 'pidroid-agent-changes'); a UTC timestamp is appended" }),
    ),
  }),
  execute: async (args, api) => {
    const result = await writeBundle(args.name ? String(args.name) : undefined);
    api.output(result.lines.join("\n"));
    return {};
  },
});

export default defineExtension({
  name: "save-bundle",
  tools: [saveBundle],
});