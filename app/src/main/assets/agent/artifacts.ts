/**
 * Artifacts: what the agent shows the user.
 *
 * Tool calls fold away in the chat (a run reads "Ran 3 commands, read a file ›"), so anything the
 * agent wants the user to *see* -- a chart, a mock-up, a table, a small app -- goes through `show`,
 * whose calls are drawn as cards that stay in the open. A card is an HTML page from the session's
 * workspace, served by /workspace/<session>/<path> into a sandboxed iframe (opaque origin: it can
 * run scripts but cannot reach the app). The result's last line is a {"artifact":...} payload the
 * page reads the card from.
 */

import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { extname, join, sep } from "path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

const ARTIFACTS_DIR = ".artifacts";

export const showTool = defineTool({
  name: "show",
  description:
    "Show the user an HTML page as a card in the chat. Your tool calls are folded out of sight, so this is how to put something " +
    "in front of the user: a chart or graph, a diagram, a table, a mock-up, a small interactive demo, a rendered report. " +
    "Either pass `html` (a complete document; it is saved under .artifacts/ in your workspace) or `path` to an .html file you " +
    "already wrote inside your workspace (relative CSS, JS and images next to it load too). Showing the same path again after " +
    "editing it updates the earlier card as well, so prefer that to a new file when revising. " +
    "The page runs in a sandboxed iframe about 360px tall on a phone screen (set `height` for more), with no network access " +
    "guaranteed and no libraries: write plain HTML, CSS, SVG and JavaScript. Make it responsive (width: 100%), set a background, " +
    "and use a dark theme (#000 background, light text) to match the app. " +
    "For a function graph or data plot, draw it yourself: sample the values in JavaScript and draw an SVG <polyline> (or a canvas " +
    "path) inside a viewBox, with light grid lines, labelled ticks on both axes, axis lines through 0 when visible, and a short " +
    "caption; break the line where values are not finite or jump off the chart.",
  parameters: Type.Object({
    title: Type.String({ description: "Short title for the card, e.g. \"Loan repayment chart\"" }),
    html: Type.Optional(Type.String({ description: "A complete HTML document to show (saved to .artifacts/ in the workspace)" })),
    path: Type.Optional(Type.String({ description: "Path to an .html file inside the workspace to show instead of `html`" })),
    height: Type.Optional(Type.Number({ description: "Card height in CSS pixels (120-900, default 360)" })),
  }),
  async execute(args, api, context) {
    const root = await api.env.absolutePath(".", context);
    if (!root.ok) throw root.error;
    const workspace = realpathSync(root.value);
    let file: string;
    if (typeof args.html === "string" && args.html.trim()) {
      if (args.path) throw new Error("Pass either html or path, not both.");
      const slug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "artifact";
      const dir = join(workspace, ARTIFACTS_DIR);
      mkdirSync(dir, { recursive: true });
      file = join(dir, `${slug}-${randomUUID().slice(0, 8)}.html`);
      writeFileSync(file, args.html);
    } else if (typeof args.path === "string" && args.path.trim()) {
      const resolved = await api.env.absolutePath(args.path, context);
      if (!resolved.ok) throw resolved.error;
      if (!existsSync(resolved.value) || !statSync(resolved.value).isFile()) throw new Error(`No such file: ${args.path}`);
      file = realpathSync(resolved.value);
      if (!file.startsWith(workspace + sep)) throw new Error(`Only files inside your workspace (${workspace}) can be shown; copy it there first.`);
      if (![".html", ".htm"].includes(extname(file).toLowerCase())) throw new Error("Only .html pages can be shown; wrap an image, SVG or text in an HTML page.");
    } else {
      throw new Error("Pass html (a document to show) or path (an .html file in your workspace).");
    }
    const rel = file.slice(workspace.length + 1).split(sep).join("/");
    const height = typeof args.height === "number" && Number.isFinite(args.height) ? Math.round(Math.min(900, Math.max(120, args.height))) : undefined;
    const payload = JSON.stringify({ artifact: { path: rel, title: args.title, ...(height ? { height } : {}) } });
    return { content: [{ type: "text", text: `Shown to the user as "${args.title}" (${rel}).\n${payload}` }] };
  },
});
