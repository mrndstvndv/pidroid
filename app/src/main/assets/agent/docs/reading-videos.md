# Reading videos on Pidroid (frame sheets, no ffmpeg binary)

How to actually look at a video from inside this sandbox, and the wall you hit first.

Written 2026-10-08 while reverse-engineering OpenAI's GPT-6 "Intelligent UI" launch videos.

---

## The short version

You cannot run `ffmpeg`. You do not need to. Run **ffmpeg compiled to WebAssembly** inside Bun,
and cut frames out of **Vimeo's sprite sheet** so there is no video decoding to do at all.

```bash
bun add @ffmpeg/core@0.12.6
bun sheet.ts <vimeoVideoId> ...
# -> sheets/<id>.png, a 4x3 contact sheet you can pass straight to the `read` tool
```

**If the video is a local file** — an mp4 attached from the phone, a screen recording — there is no
sprite sheet to lean on, so it does get decoded. That case is `tools/frames.ts`, already written:

```bash
bun $PIDROID_APP_DIR/tools/frames.ts <video> [out.png] [cols] [rows]
# -> out.png, an evenly sampled contact sheet with a timestamp under each frame
```

It installs `@ffmpeg/core` into `tools/node_modules` on first use (32 MB, once), so an install that
never looks at a video never pays for it.

---

## Why the normal route fails

### 1. There is no ffmpeg, and installing one does not work

`bun add ffmpeg-static` **resolves and downloads fine** and then fails at the install script:

```
install script from "ffmpeg-static" exited with 127
shell-init: error retrieving current directory: ...
/system_ext/bin/bash: line 1: node: command not found
```

Two separate problems: the postinstall shells out to `node` (absent — this is `bun`), and even if
you bypass it with `bun node_modules/ffmpeg-static/install.js`:

```
ffmpeg-static install failed: No binary found for architecture
```

`ffmpeg-static` only ships glibc x64/arm64 linux binaries. This is Android/bionic.

### 2. You cannot exec a binary even if you get one

Downloading a real static build works fine (`johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz`,
19 MB, HTTP 200). But you cannot run it:

```
$ ./ffmpeg -version
/system_ext/bin/bash: line 1: ./ffmpeg: Permission denied
```

`chmod +x` succeeds, so it is not a permission bit — it is the mount:

```
$ grep ' /data/data ' /proc/mounts
tmpfs /data/data tmpfs rw,seclabel,nosuid,nodev,noexec,relatime,mode=751 0 0
```

**`/data/data` is `noexec`.** Your workspace, `/tmp`-equivalent scratch, the agent dir — all under it.
So is anything else the app can write. Do not spend time hunting for a writable exec path:

| Candidate | Result |
| --- | --- |
| `$PIDROID_WORKSPACE` | writable, `noexec` |
| `/storage/emulated/0` | `drwxrws--- shell:shell` — our uid is not `shell` |
| `/storage/emulated/0/Download` | owned by a different app uid |
| `/data/local/tmp` | `drwxrwx--x shell:shell` — not us |
| `/data/media/0` | not us |

SELinux is also `untrusted_app`, so even an exec-capable path would need an execcon nobody has.

**Conclusion: everything must happen in-process, in JS/WASM.** Bun is the only tool that has both a
runtime and enough memory to do this.

### 3. Bonus trap: no `xz`, so tarballs are unreadable

The usual static builds ship as `.tar.xz`, and there is no `xz`/`unxz`/`busybox`/`python3` here
(`zstd` exists at `/system_ext/bin/zstd`; `xz` does not). Work around it with the pure-JS wasm decoder:

```bash
bun add xz-decompress
```

```ts
// unxz.ts — streaming xz decompression with no native code
import { XzReadableStream } from "xz-decompress";
const src = Bun.file(process.argv[2]);
const buf = await new Response(new XzReadableStream(src.stream())).arrayBuffer();
await Bun.write(process.argv[3], new Uint8Array(buf));
```

```bash
bun unxz.ts ff.tar.xz ff.tar && tar xf ff.tar
```

Only worth it if you have decided to use the binary — which you cannot. Kept here because
`.tar.xz` shows up in every ffmpeg/ffprobe download you will try.

---

## The actual solution: ffmpeg.wasm

```bash
bun add @ffmpeg/core@0.12.6
```

It works under Bun with no worker and no `SharedArrayBuffer` (the single-threaded core):

```ts
import createFFmpegCore from "@ffmpeg/core";
const core: any = await createFFmpegCore({
  logLevel: "error",
  locateFile: (p: string) => new URL(p, import.meta.resolve("@ffmpeg/core")).pathname,
} as any);
core.setLogger((l: any) => { if (l.type === "error") console.error(l.message); });
core.exec("-version");   // rc 0 — ffmpeg 5.1.4
```

Build config confirms you get everything you need: `libx264`, `libwebp`, `libfreetype`,
`libfribidi`, `libass`, `libzimg`, plus the full `libavfilter` (so `xstack`, `tile`, `crop`,
`drawtext` all work).

Cost: it is a 32 MB wasm module, and each `core.exec()` is a full ffmpeg run against a MEMFS
filesystem. It is fast enough — a 12-frame contact sheet per video built in a few seconds each.

### MEMFS is not your disk

`core.FS.writeFile()` writes into the in-memory filesystem, **not** the workspace. A run will
"succeed", `ls` the output path and find nothing. You must copy out:

```ts
await Bun.write(`sheets/${id}.png`, core.FS.readFile(`/sheets/${id}.png`));
```

Also: directories must exist first (`core.FS.mkdir("/frames")`), and `FS.writeFile` wants a
`Uint8Array` — `Bun.file(...).arrayBuffer()` throws `Unsupported data type`, `.bytes()` works.

---

## Skip video decoding entirely: the sprite sheet

Most OpenAI/YouTube-adjacent videos on marketing pages are Vimeo, and Vimeo's player config
exposes a **sprite sheet** of evenly spaced frames. That is *already* the frame extraction, done
server-side. One HTTP GET, no codec, no DASH parsing.

```ts
const j = await (await fetch(
  `https://player.vimeo.com/video/${id}/config?h=${hash}`,
  { headers: { Referer: "https://openai.com/" } },   // required; else 403
)).json();

j.request.thumb_preview
// {
//   url: "https://videoapi-sprites.vimeocdn.com/video-sprites/image/<uuid>.0.webp?...",
//   width: 4686, height: 2640,
//   columns: 11, frames: 120,
//   frame_width: 426, frame_height: 240
// }
```

Cell index -> pixel origin:

```
idx  = frame number
col  = idx % columns
row  = floor(idx / columns)
x    = col * frame_width
y    = row * frame_height
t    = (idx / frames) * video.duration     // seconds, for labelling
```

The `h=` hash is not secret — it is in the `player.vimeo.com/video/<id>?h=<hash>` iframe `src`
on the page, so scrape it from the page HTML with a regex.

### Fetching gotchas

- `Bun.write(path, Bun.file(url))` treats the string as a **local path** and throws `ENOENT`.
  Fetch, check `r.ok`, then `await Bun.write(path, await r.arrayBuffer())`.
- The sprite CDN rejects requests without a `Referer`/`User-Agent`. `Referer: https://player.vimeo.com/` works.

---

## ffmpeg invocation gotchas

Three things that each cost a round trip:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The specified filename '/out.png' does not contain an image sequence pattern` | image2 muxer refuses a single frame | add `-update 1` |
| `No such file or directory` on output, `rc=1` | output directory does not exist in MEMFS | `core.FS.mkdir()` first |
| `Unsupported data type` from `FS.writeFile` | passed an `ArrayBuffer` | pass `Uint8Array` (`.bytes()`) |

And capture **stderr**, not just `type === "error"` — ffmpeg logs its actual failure as
`type: "stderr"`, so a logger filtered to `error` type shows you an empty message and `rc=1`.

---

## The whole pipeline

```ts
// sheet.ts — vite config: none, runs under plain `bun sheet.ts <id>...`
import createFFmpegCore from "@ffmpeg/core";
const core: any = await createFFmpegCore({
  logLevel: "error",
  locateFile: (p: string) => new URL(p, import.meta.resolve("@ffmpeg/core")).pathname,
} as any);
let err = "";
core.setLogger((l: any) => { if (l.type === "error" || l.type === "stderr") err += l.message + "\n"; });
const run = (args: string[]) => {
  err = "";
  const rc = core.exec(...args);
  if (rc !== 0) throw new Error(`ffmpeg rc=${rc} :: ${args.join(" ")}\n${err.slice(0, 600)}`);
};
const FS = core.FS;
for (const d of ["/frames", "/sheets"]) { try { FS.mkdir(d); } catch {} }
FS.writeFile("/font.ttf", await Bun.file("/system/fonts/DroidSans-Bold.ttf").bytes());

const COLS = 4, ROWS = 3, N = COLS * ROWS;
const FW = 426, FH = 240;          // sprite cell size
const SW = 470, SH = 264, STRIP = 30, CELLH = SH + STRIP;
const pad2 = (n: number) => String(n).padStart(2, "0");
const layout = Array.from({ length: N }, (_, k) =>
  `${(k % COLS) * SW}_${Math.floor(k / COLS) * CELLH}`).join("|");

for (const id of process.argv.slice(2)) {
  const meta = JSON.parse(await Bun.file(`vid/${id}.json`).text());
  const { frames, columns } = meta.sprite;
  FS.writeFile(`/s${id}.webp`, await Bun.file(`vid/${id}.webp`).bytes());

  for (let k = 0; k < N; k++) {
    const idx = Math.round(k * (frames - 1) / (N - 1));
    const cx = (idx % columns) * FW, cy = Math.floor(idx / columns) * FH;
    const t = (idx / frames) * meta.duration;
    const vf = `crop=${FW}:${FH}:${cx}:${cy},scale=${SW}:${SH},pad=${SW}:${CELLH}:0:${STRIP}:black,` +
               `drawtext=fontfile=/font.ttf:text='${pad2(k)}  ${t.toFixed(1)}s':` +
               `x=7:y=7:fontsize=19:fontcolor=white`;
    run(["-i", `/s${id}.webp`, "-frames:v", "1", "-update", "1", "-vf", vf,
         `/frames/f${id}_${pad2(k)}.png`]);
  }

  const ins = Array.from({ length: N }, (_, k) => `-i /frames/f${id}_${pad2(k)}.png`).join(" ");
  const st  = Array.from({ length: N }, (_, k) => `[${k}:v]`).join("");
  run([...ins.split(" "), "-filter_complex", `${st}xstack=inputs=${N}:layout=${layout}:fill=black[out]`,
       "-map", "[out]", "-frames:v", "1", "-update", "1", `sheets/${id}.png`]);

  await Bun.write(`sheets/${id}.png`, FS.readFile(`/sheets/${id}.png`));
  for (let k = 0; k < N; k++) FS.unlink(`/frames/f${id}_${pad2(k)}.png`);
  console.log("✓", id, meta.title, meta.duration + "s");
}
```

Then read it back — the `read` tool takes images and the model can actually see them:

```
read  path: sheets/1233627618.png
```

Or hand it to the user with `artifact { kind: "image", path: "sheets/1233627618.png" }`.

---

## Reading the sheets

12 frames across a 39s clip is the sweet spot: enough to see a state change, small enough
(1880×882) that the text in each cell is still legible after downscaling.

Things that only show up if you sample *evenly and densely*:

- **Progressive rendering** — a chart appearing empty at t=14s and drawn by t=21s proves the
  component streams in with the answer, rather than being attached at the end. This is the single
  most useful thing a frame sheet tells you and you cannot get it from the transcript.
- **Live state binding** — slider dragged, `rc=1` frames either side, numbers differ. That is
  evidence the widget recomputes, not that the text was written twice.
- **Follow-up affordances** — suggestion chips, "Correct." blocks, accordions expanded.

Do not over-read it: two frames showing `$1.00 trillion` then `$1.11 trillion` proves the widget
updates, not that the prose around it recomputes. If that distinction matters, say what you saw.

---

## When there is no sprite sheet

Fallback ladder, in order of preference:

1. **Vimeo HLS/DASH** — parse `j.request.files.hls.cdns.<cdn>.avc_url` (an fMP4 `.m3u8`),
   download the segments, concat. Real work; only if you must read motion.
2. **Other CDNs expose the same idea.** YouTube: `i.ytimg.com/sb/<id>/storyboard*.jpg` (L1/L2/L3
   storyboards, `sigh` signature in the watch page's `playerStoryboardSpecRenderer`). Twitter/X:
   `pbs.twimg.com/amplify_video_thumb/<id>/img.jpg`.
3. **Give up on frames, read the transcript** — Vimeo configs carry
   `j.request.captions`, and most launch pages have a written walkthrough that describes the same
   UI. Say plainly that you did not see the video.
4. **`show` an HTML page** that embeds the video or the live demo and let the user watch it
   themselves. Good for interactive product demos (`cdn.openai.com/ctf-cdn/...`) — but the iframe
   has no guaranteed network, so link out rather than embed if you can.

## Traps specific to decoding a real file

`tools/frames.ts` is the accumulated result of these. Each one cost a round trip:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `<path>: No such file or directory` on the **input** | the core only sees MEMFS; host paths do not exist inside it | `FS.writeFile("/in/video", (await Bun.file(p)).bytes())` first — same rule as the output side |
| `could not read the video's length or size` | `logLevel: "error"` hides `Duration:` and the stream line, which are info level | `logLevel: "info"`, filter in your own logger |
| frame size comes out as `137x804` slivers | `/\d+x\d+/` over the log matches `avc1 / 0x31637661` — the FourCC is digits either side of an `x` | parse only `Stream #n:0…: Video:` lines, take the largest |
| `Invalid chars 'x1079' at the end of expression` | `pad` takes `width:height`; `470x1079` is not a size | `pad=470:1079:…` |
| every frame reported missing, `rc=0` | this core build has **no `FS.statFile`** — the TypeError reads as "missing" for every frame | `FS.readdir(dir).includes(name)` |
| the last frame of a screen recording never appears | recordings get cut mid-GOP; the final seek lands in frames that do not decode | verify each cut, retry half a step earlier, tile whatever survived |
| the tile filter asks for 12 inputs and there are 6 | the grid was auto-chosen but the frame count came from the CLI defaults | compute `FRAMES` once, from the chosen grid |
| sheet is 1880x3237 and arrives unreadable | the read tool downscales, and 232px-wide phone cells lose all UI text | keep the sheet's long edge near 1600, and use fewer, larger frames for portrait |

## Do not

- Do not burn turns trying to `bun add` a native binary and exec it. `noexec` on `/data/data` is
  absolute; no writable exec path exists. This cost ~6 tool calls to establish.
- Do not download a 100 MB 4K video to look at 12 frames of it.
- Do not dump a 588 KB scraped HTML page through `grep` — one `grep .{500}` on a minified
  Next.js page returns 315 KB and floods the context. Strip `<script>`/`<style>` first, extract
  headings and media URLs in document order in a small script, and print only those.