/**
 * frames.ts -- contact sheet from a local video file, using ffmpeg compiled to WebAssembly.
 *
 *   bun tools/frames.ts <video> [out.png] [cols] [rows]
 *
 * Why this exists: docs/reading-videos.md ends at Vimeo's sprite sheet, which needs no decoding at
 * all and so says nothing about the case you hit when someone attaches an mp4 from their phone --
 * you cannot read it, there is no ffmpeg binary to exec (/data/data is noexec), and the read tool
 * takes images, not video. So: decode in WASM, cut N evenly spaced frames, tile them into one PNG
 * the read tool can actually look at.
 *
 * The 32 MB @ffmpeg/core module is installed on first use rather than shipped in the app tree, so
 * an install that never looks at a video never pays for one.
 *
 * Sampling is even *and* dense on purpose: a frame sheet is how you catch a widget that renders
 * progressively or binds to live state, and both hide completely if you sample too sparsely.
 */
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join } from "path";

// --- ffmpeg.wasm, installed on demand -------------------------------------------------------
const HERE = dirname(new URL(import.meta.url).pathname);
const LOCAL = join(HERE, "node_modules", "@ffmpeg", "core");
if (!existsSync(LOCAL)) {
  console.log("first run: installing @ffmpeg/core into tools/node_modules (32 MB, once)...");
  const pkg = join(HERE, "package.json");
  if (!existsSync(pkg)) await Bun.write(pkg, JSON.stringify({ name: "pidroid-tools", private: true }, null, 2));
  const r = spawnSync("bun", ["add", "@ffmpeg/core@0.12.6"], { cwd: HERE, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`could not install @ffmpeg/core (bun add exited ${r.status})`);
}
const { default: createFFmpegCore } = await import(LOCAL);

const videoPath = process.argv[2];
const outPath = process.argv[3] || "sheet.png";
const COLS = Number(process.argv[4]) || 4;
const ROWS = Number(process.argv[5]) || 3;

if (!videoPath) {
  console.error("usage: bun tools/frames.ts <video> [out.png] [cols] [rows]");
  process.exit(1);
}

const core: any = await createFFmpegCore({
  // "info", not "error": the probe below reads Duration and the stream size, which ffmpeg prints
  // at info level. Filtering them out here is what makes the first version of this look like a
  // video it cannot read rather than a log level that hid the answer.
  logLevel: "info",
  locateFile: (p: string) => join(dirname(new URL(import.meta.resolve(LOCAL)).pathname), p),
} as any);

// ffmpeg logs its real failure as type "stderr", not "error": a logger filtered to errors shows an
// empty message next to rc=1 and costs a round trip every time.
let err = "";
core.setLogger((l: any) => {
  if (l.type === "error" || l.type === "stderr") err += l.message + "\n";
});
const run = (args: string[]) => {
  err = "";
  const rc = core.exec(...args);
  if (rc !== 0) throw new Error(`ffmpeg rc=${rc} :: ${args.join(" ")}\n${err.slice(-900)}`);
};

const FS = core.FS;
for (const d of ["/in", "/frames", "/out"]) { try { FS.mkdir(d); } catch {} }
FS.writeFile("/font.ttf", await Bun.file("/system/fonts/DroidSans-Bold.ttf").bytes());

// The core only ever sees MEMFS: a host path passed to it is "No such file or directory", and the
// same is true of the output on the way back. Both directions cross this line explicitly.
const bytes = await Bun.file(videoPath).bytes();
FS.writeFile("/in/video", bytes);
const IN = "/in/video";
console.log(`read ${basename(videoPath)} (${(bytes.length / 1e6).toFixed(1)} MB) into MEMFS`);

// --- probe ---------------------------------------------------------------------------------
// There is no ffprobe in @ffmpeg/core, and `-i` alone exits 1 by design. The information we need
// is on stderr either way, so a non-zero rc here is the expected outcome, not a failure.
err = "";
core.exec("-i", IN);
const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
// Pick the biggest video stream. The naive /\d+x\d+/ over the log matches "avc1 / 0x31637661" --
// the FourCC, which is digits either side of an "x" -- before it ever reaches the real resolution,
// and 0x3163 as a frame size produces a sheet of slivers.
const sizes = err.split("\n")
  .filter((l) => /Stream #\d+:\d+.*: Video:/.test(l))
  .map((l) => /[, ](\d{2,5})x(\d{2,5})[, ]/.exec(l))
  .filter(Boolean)
  .map((m) => ({ w: Number(m![1]), h: Number(m![2]) }))
  .filter((s) => s.w > 0 && s.h > 0)
  .sort((a, b) => b.w * b.h - a.w * a.h);
const big = sizes[0];
if (!duration || !big) throw new Error(`could not read the video's length or size:\n${err.slice(-800)}`);
const vw = big.w, vh = big.h;
console.log(`${basename(videoPath)}: ${vw}x${vh}, ${duration.toFixed(2)}s`);

// --- layout ---------------------------------------------------------------------------------
// Three decisions, all of which have to agree with each other -- they did not, at first, and the
// symptom was a tiling filter asking for 12 inputs when only 6 had been cut.
//
// 1. Cells keep the video's aspect: a portrait phone recording forced into a landscape cell wastes
//    most of the sheet.
// 2. The grid is chosen by shape and length. A 3-second screen recording is all motion, so it gets
//    the dense 4x3; a long portrait clip gets 3x2, because 4x3 of portrait frames is a 1880x3237
//    sheet that the read tool hands back downscaled to 232px-wide cells where no UI text survives.
// 3. Everything is then scaled so the sheet's long edge lands near MAX_EDGE, which is the same
//    readability constraint as (2), applied to the grid you asked for.
const LANDSCAPE = [4, 3];
const PORTRAIT_LONG = [3, 2];
const PORTRAIT_SHORT = [3, 3];
const MAX_EDGE = 1600;
const SHORT_CLIP = 12; // seconds

const aspect = vh / vw;
const AUTO = aspect > 1
  ? (duration <= SHORT_CLIP ? PORTRAIT_SHORT : PORTRAIT_LONG)
  : LANDSCAPE;
const [DEF_COLS, DEF_ROWS] = (process.argv[4] || process.argv[5]) ? [COLS, ROWS] : AUTO;
const FRAMES = DEF_COLS * DEF_ROWS; // one number, computed once, used everywhere below

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Cell size for a given aspect, shrunk so the grid's long edge lands near MAX_EDGE. */
const fit = (aspect: number) => {
  let cw = Math.min(470, Math.floor(MAX_EDGE / DEF_COLS));
  let ch = Math.round(cw * aspect);
  let strip = Math.max(16, Math.round(cw * 0.072));
  const tall = DEF_ROWS * (ch + strip);
  if (tall > MAX_EDGE) {
    const k = MAX_EDGE / tall;
    cw = Math.max(120, Math.round(cw * k));
    ch = Math.round(ch * k);
    strip = Math.max(14, Math.round(strip * k));
  }
  return { cw, ch, strip, cell: ch + strip };
};
const { cw: CELL_W, ch: CELL_H, strip: STRIP, cell: CELL } = fit(aspect);
console.log(`grid ${DEF_COLS}x${DEF_ROWS} = ${FRAMES} frames, cell ${CELL_W}x${CELL}, ` +
            `sheet ${DEF_COLS * CELL_W}x${DEF_ROWS * CELL}`);

// Evenly spaced across the whole clip, inset by half a step so the first and last frames are real
// frames of the video rather than the black that ffmpeg shows at t=0 on some encoders.
const step = duration / FRAMES;
const times = Array.from({ length: FRAMES }, (_, k) => (k + 0.5) * step);

// Screen recordings are frequently cut off mid-GOP, and the last seek then lands in frames that do
// not decode: ffmpeg exits 0 having written nothing. So each cut is verified, a missing one is
// retried half a step earlier, and whatever survived is what gets tiled -- a 9-cell sheet beats a
// tiling filter asking for an input that was never written.
//
// Existence is checked through readdir, not FS.statFile: this core build has no statFile, and
// asking it for one throws a TypeError that reads as "the frame is missing" for all twelve of them.
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const exists = (p: string) => {
  try { return FS.readdir(dirOf(p)).includes(nameOf(p)); } catch { return false; }
};

const cut = (t: number, path: string) => {
  const vf = `scale=${CELL_W}:${CELL_H},pad=${CELL_W}:${CELL}:0:${STRIP}:black,` +
             `drawtext=fontfile=/font.ttf:text='${t.toFixed(1)}s':x=6:y=${STRIP + 4}:` +
             `fontsize=${Math.max(13, Math.round(CELL_W * 0.043))}:fontcolor=white`;
  // -ss before -i: ffmpeg seeks to the nearest keyframe and decodes forward to the exact timestamp,
  // so these frames are where they claim to be even in a screen recording with sparse keyframes.
  run(["-ss", t.toFixed(3), "-i", IN, "-frames:v", "1", "-update", "1", "-vf", vf, path]);
  return exists(path);
};

const files: string[] = [];
for (const [k, t] of times.entries()) {
  const path = `/frames/f${pad2(k)}.png`;
  if (cut(t, path) || (t - step / 2 > 0 && cut(t - step / 2, path))) {
    files.push(path);
  } else {
    console.log(`  no frame at ${t.toFixed(2)}s (truncated clip?) -- skipping it`);
  }
}
if (!files.length) throw new Error("no frames could be decoded from this video");
if (files.length < FRAMES) console.log(`${files.length}/${FRAMES} frames decoded`);

// --- tile -----------------------------------------------------------------------------------
const ins = files.map((f) => `-i ${f}`).join(" ");
const st = files.map((_, k) => `[${k}:v]`).join("");
const layout = files.map((_, k) => `${(k % DEF_COLS) * CELL_W}_${Math.floor(k / DEF_COLS) * CELL}`).join("|");
run([...ins.split(" "), "-filter_complex", `${st}xstack=inputs=${files.length}:layout=${layout}:fill=black[out]`,
     "-map", "[out]", "-frames:v", "1", "-update", "1", "/out/sheet.png"]);

// MEMFS is not your disk: copy out or the file is gone with the process.
await Bun.write(outPath, FS.readFile("/out/sheet.png"));
for (const f of files) FS.unlink(f);
console.log(`✓ ${outPath}`);
