/**
 * image_edit: decode, resize, rotate, crop and re-encode images, entirely in-process.
 *
 * Why not ffmpeg: there is no libav*.so on Android (the platform ships MediaCodec/codec2, not
 * ffmpeg), ffmpeg-kit was retired and is gone from Maven, node-av -- which @mediabunny/server
 * wraps -- publishes no Android build, and sharp has no @img/sharp-android-*. None of them can be
 * built here either: no clang, no NDK, no node-gyp. So the ffmpeg route is closed.
 *
 * What this uses instead is jsquash -- the WASM codecs from Google's Squoosh, repackaged as
 * zero-dependency ESM. Pure WASM means no native linking, so it runs under Bun on Android. Measured
 * on-device: jpeg/webp/avif/jxl encode+decode all round-trip, alpha survives everywhere except jpeg,
 * and all 7 resize methods work.
 *
 * Two gaps in jsquash are filled here by hand, because the @jsquash scope is only 8 packages and
 * contains no rotate, crop, blur or sharpen at all:
 *   - rotate/flip, over the raw RGBA buffer
 *   - arbitrary crop, over the raw RGBA buffer
 * Both are cheap row/column copies; a blur or sharpen would be a per-pixel loop and is deliberately
 * left out (too slow in JS at full resolution).
 *
 * Sharp edges worth knowing when using this:
 *   - the codecs want ImageData-shaped objects ({data,width,height,colorSpace}), NOT bare typed
 *     arrays. Handing them a Uint8ClampedArray dies inside the WASM glue with a misleading
 *     "Cannot pass non-string to std::string".
 *   - png/avif/jxl/webp encode() return an ArrayBuffer that is NOT iterable under Bun. Wrap in
 *     new Uint8Array() before slicing it or writing it out.
 *   - resize() needs an explicit height. Passing 0 does not preserve aspect ratio, it silently
 *     produces a 0-height image that then fails in the next encoder. Aspect is computed here.
 *   - @jsquash/oxipng exports `optimise` (not encode/decode like the others).
 *
 * avif is ~5x slower than webp to encode (~1s for a small image, worse on a big photo) but produces
 * the smallest files by a wide margin. jpeg flattens alpha to opaque -- there is no jpeg alpha.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import encodeJpeg from "@jsquash/jpeg/encode.js";
import decodeJpeg from "@jsquash/jpeg/decode.js";
import encodePng from "@jsquash/png/encode.js";
import decodePng from "@jsquash/png/decode.js";
import encodeWebp from "@jsquash/webp/encode.js";
import decodeWebp from "@jsquash/webp/decode.js";
import encodeAvif from "@jsquash/avif/encode.js";
import decodeAvif from "@jsquash/avif/decode.js";
import { initResize, default as resizeImage } from "@jsquash/resize";
import { optimise as optimisePng } from "@jsquash/oxipng";

// ---------------------------------------------------------------------------------------------
// codec registry
// ---------------------------------------------------------------------------------------------

type Decoded = { data: Uint8ClampedArray; width: number; height: number };

interface Codec {
  decode: (bytes: Uint8Array) => Promise<Decoded>;
  encode: (img: Decoded, quality: number) => Promise<ArrayBuffer | Uint8Array>;
  ext: string;
  mime: string;
  /** false for jpeg, which has no alpha channel at all. */
  alpha: boolean;
  label: string;
}

const CODECS: Record<string, Codec> = {
  jpeg: {
    decode: (b) => decodeJpeg(b) as Promise<Decoded>,
    encode: (i, q) => encodeJpeg(toImageData(i), { quality: q }),
    ext: "jpg", mime: "image/jpeg", alpha: false, label: "MozJPEG",
  },
  png: {
    decode: (b) => decodePng(b) as Promise<Decoded>,
    encode: (i) => encodePng(toImageData(i)),
    ext: "png", mime: "image/png", alpha: true, label: "PNG",
  },
  webp: {
    decode: (b) => decodeWebp(b) as Promise<Decoded>,
    encode: (i, q) => encodeWebp(toImageData(i), { quality: q }),
    ext: "webp", mime: "image/webp", alpha: true, label: "WebP",
  },
  avif: {
    decode: (b) => decodeAvif(b) as Promise<Decoded>,
    encode: (i, q) => encodeAvif(toImageData(i), { quality: q }),
    ext: "avif", mime: "image/avif", alpha: true, label: "AVIF",
  },
};

/** Sniff the format from magic bytes -- more reliable than trusting the extension. */
function sniffFormat(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    return "webp"; // RIFF....WEBP
  }
  if (b[4] === 0x66 && b[8] === 0x66 && b[12] === 0x66) return "avif"; // ....ftypavif-ish
  if (b[0] === 0xff && b[1] === 0x0a) return "avif"; // JPEG XL codestream
  if (b[12] === 0x4a && b[13] === 0x58 && b[14] === 0x4c && b[15] === 0x20) return "avif"; // jxlc/jxlp
  return null;
}

// ---------------------------------------------------------------------------------------------
// pixel helpers (the operations jsquash does not provide)
// ---------------------------------------------------------------------------------------------

function toImageData(i: Decoded): any {
  return { data: i.data, width: i.width, height: i.height, colorSpace: "srgb" };
}

/** Copy a w*h*4 block out of a larger RGBA image. */
function cropRaw(img: Decoded, sx: number, sy: number, w: number, h: number): Decoded {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((sy + y) * img.width + sx) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Rotate by 0/90/180/270 degrees clockwise, optionally mirroring. */
function rotateRaw(img: Decoded, degrees: number, flipH: boolean, flipV: boolean): Decoded {
  const { data, width: w, height: h } = img;
  const quarter = ((Math.round(degrees / 90) % 4) + 4) % 4;
  const swap = quarter === 1 || quarter === 3;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      // mirror first, in source coordinates
      const mx = flipH ? w - 1 - x : x;
      const my = flipV ? h - 1 - y : y;
      // then rotate clockwise
      let dx: number, dy: number;
      switch (quarter) {
        case 1: dx = h - 1 - my; dy = mx; break;
        case 2: dx = w - 1 - mx; dy = h - 1 - my; break;
        case 3: dx = my; dy = w - 1 - mx; break;
        default: dx = mx; dy = my;
      }
      const di = (dy * ow + dx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { data: out, width: ow, height: oh };
}

/** Clamp a requested box to the image and validate it. */
function clampBox(img: Decoded, box: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(0, Math.min(Math.round(box.x), img.width - 1));
  const y = Math.max(0, Math.min(Math.round(box.y), img.height - 1));
  const width = Math.max(1, Math.min(Math.round(box.width), img.width - x));
  const height = Math.max(1, Math.min(Math.round(box.height), img.height - y));
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------------------------
// shared pipeline
// ---------------------------------------------------------------------------------------------

async function loadImage(path: string): Promise<{ img: Decoded; format: string }> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (!bytes.length) throw new Error(`empty file: ${path}`);

  const sniffed = sniffFormat(bytes);
  const fromExt = extname(path).slice(1).toLowerCase().replace(/^jpe?g$/, "jpeg");
  const format = sniffed ?? (CODECS[fromExt] ? fromExt : null);
  if (!format || !CODECS[format]) {
    throw new Error(
      `unsupported image format${sniffed === null && !CODECS[fromExt] ? " (not jpeg/png/webp/avif)" : ""}: ${path}`,
    );
  }
  let img: Decoded;
  try {
    img = await CODECS[format].decode(bytes);
  } catch (e) {
    throw new Error(`failed to decode ${format}: ${(e as Error).message ?? e}`);
  }
  if (!img.width || !img.height) throw new Error(`decoded image has zero size: ${path}`);
  return { img, format };
}

async function saveImage(
  img: Decoded,
  format: string,
  outPath: string,
  quality: number,
): Promise<{ bytes: number; format: string }> {
  const codec = CODECS[format];
  // jpeg has no alpha: flatten onto white rather than emitting a black background.
  let toEncode = img;
  if (!codec.alpha && img.data.some((_, i) => i % 4 === 3 && _ !== 255)) {
    const flat = new Uint8ClampedArray(img.data);
    for (let i = 0; i < flat.length; i += 4) {
      const a = flat[i + 3] / 255;
      flat[i] = flat[i] * a + 255 * (1 - a);
      flat[i + 1] = flat[i + 1] * a + 255 * (1 - a);
      flat[i + 2] = flat[i + 2] * a + 255 * (1 - a);
      flat[i + 3] = 255;
    }
    toEncode = { data: flat, width: img.width, height: img.height };
  }
  const raw = await codec.encode(toEncode, quality);
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as Uint8Array).buffer);
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, bytes);
  return { bytes: bytes.byteLength, format };
}

function describeSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

/** Append _1, _2 ... until the path is free. Never silently overwrites the source image. */
async function uniquePath(path: string): Promise<string> {
  if (!(await Bun.file(path).exists())) return path;
  const dot = extname(path);
  const stem = path.slice(0, path.length - dot.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem}_${n}${dot}`;
    if (!(await Bun.file(candidate).exists())) return candidate;
  }
  throw new Error(`could not find a free filename near ${path}`);
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

const FORMAT_ENUM = Type.Union(["jpeg", "png", "webp", "avif"].map((v) => Type.Literal(v)));
const RESIZE_METHOD_ENUM = Type.Union(
  ["triangle", "catrom", "mitchell", "lanczos3", "hqx", "magicKernel", "magicKernelSharp2021"].map((v) =>
    Type.Literal(v),
  ),
);

const inspectImage = defineTool({
  name: "image_inspect",
  // The chat view reads this (see extensions.ts): the parameters are one path, but the result is the
  // readable report the tool prints, so that is what the row shows instead of a JSON dump.
  view: { icon: "image", body: "output", verb: { one: "inspected an image", many: "inspected {n} images" } },
  description:
    "Read an image's dimensions and format without fully processing it. Decodes jpeg/png/webp/avif " +
    "in-process via WASM. Use this first when you need to know an image's size before cropping or " +
    "resizing, since crop boxes are absolute pixel coordinates.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute path to the image file" }),
  }),
  execute: async (args, api) => {
    const t0 = performance.now();
    const { img, format } = await loadImage(args.path);
    const bytes = (await Bun.file(args.path).arrayBuffer()).byteLength;
    api.output(
      [
        `${args.path}`,
        `  format:  ${format} (${CODECS[format].label}), ${describeSize(bytes)}`,
        `  size:    ${img.width} x ${img.height} (${(img.width * img.height / 1e6).toFixed(2)} MP)`,
        `  decoded in ${(performance.now() - t0) | 0}ms`,
      ].join("\n"),
    );
    return { width: img.width, height: img.height, format, bytes };
  },
});

const editImage = defineTool({
  name: "image_edit",
  view: { icon: "image", body: "output", summaryArg: "input", verb: { one: "edited an image", many: "edited {n} images" } },
  description:
    "Decode, transform and re-encode an image. Operations run in the order: crop, rotate, flip, " +
    "resize. Supports jpeg/png/webp/avif in and any of those out, so it also does format " +
    "conversion. Rotation is clockwise in degrees; flip mirrors before rotating. When only one of " +
    "width/height is given the other is computed to preserve aspect ratio. Never overwrites the " +
    "input file -- an output path that already exists gets a _1 suffix. Note jpeg cannot store " +
    "alpha: converting an image with transparency to jpeg flattens it onto white.",
  parameters: Type.Object({
    input: Type.String({ description: "Absolute path to the source image" }),
    output: Type.Optional(Type.String({ description: "Output path (default: derived from input)" })),
    format: Type.Optional(FORMAT_ENUM as any),
    quality: Type.Optional(Type.Number({ description: "1-100, lossy formats only (default 85)" })),
    crop: Type.Optional(
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
      }),
    ),
    rotate: Type.Optional(Type.Number({ description: "Clockwise degrees: 0, 90, 180 or 270" })),
    flipH: Type.Optional(Type.Boolean({ description: "Mirror horizontally" })),
    flipV: Type.Optional(Type.Boolean({ description: "Mirror vertically" })),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
    method: Type.Optional(RESIZE_METHOD_ENUM as any),
  }),
  execute: async (args, api) => {
    const t0 = performance.now();
    const { img, format: inFormat } = await loadImage(args.input);
    const steps: string[] = [`decode ${inFormat} ${img.width}x${img.height}`];
    let cur = img;

    if (args.crop) {
      const b = clampBox(cur, args.crop);
      if (b.width !== args.crop.width || b.height !== args.crop.height) {
        steps.push(`crop clamped to ${b.width}x${b.height}+${b.x}+${b.y}`);
      }
      cur = cropRaw(cur, b.x, b.y, b.width, b.height);
      steps.push(`crop -> ${cur.width}x${cur.height}`);
    }

    const degrees = ((Math.round((args.rotate ?? 0) / 90) % 4) + 4) % 4;
    const flipH = !!args.flipH;
    const flipV = !!args.flipV;
    if (degrees !== 0 || flipH || flipV) {
      cur = rotateRaw(cur, degrees * 90, flipH, flipV);
      steps.push(`rotate ${degrees * 90}deg${flipH ? " +flipH" : ""}${flipV ? " +flipV" : ""} -> ${cur.width}x${cur.height}`);
    }

    if (args.width != null || args.height != null) {
      // Aspect is computed here because resize() silently makes a 0-height image if you pass 0.
      const ratio = cur.width / cur.height;
      let tw = args.width ?? 0;
      let th = args.height ?? 0;
      if (tw > 0 && th <= 0) th = Math.max(1, Math.round(tw / ratio));
      else if (th > 0 && tw <= 0) tw = Math.max(1, Math.round(th * ratio));
      if (tw <= 0 || th <= 0) throw new Error("resize needs a positive width and/or height");
      tw = Math.max(1, Math.min(Math.round(tw), 20000));
      th = Math.max(1, Math.min(Math.round(th), 20000));
      const t = performance.now();
      await initResize();
      cur = (await resizeImage(cur as any, { width: tw, height: th, method: args.method ?? "lanczos3" })) as any;
      steps.push(`resize ${args.method ?? "lanczos3"} -> ${cur.width}x${cur.height} (${(performance.now() - t) | 0}ms)`);
    }

    const outFormat = args.format ?? inFormat;
    const quality = Math.max(1, Math.min(Math.round(args.quality ?? 85), 100));

    // derive a default output path from the input + target format
    let outPath = args.output;
    if (!outPath) {
      const dot = extname(args.input);
      const stem = dot ? args.input.slice(0, -dot.length) : args.input;
      outPath = `${stem}.${CODECS[outFormat].ext}`;
    }
    const finalPath = await uniquePath(outPath);

    const { bytes } = await saveImage(cur, outFormat, finalPath, quality);
    api.output(
      [
        `${args.input} -> ${finalPath}`,
        ...steps.map((s) => `  ${s}`),
        `  wrote ${outFormat} ${describeSize(bytes)} (quality ${quality})`,
        `  total ${(performance.now() - t0) | 0}ms`,
      ].join("\n"),
    );
    return {
      path: finalPath, format: outFormat, width: cur.width, height: cur.height, bytes,
    };
  },
});

const optimiseImage = defineTool({
  name: "image_optimise",
  view: { icon: "image", body: "output", summaryArg: "input", verb: { one: "optimised an image", many: "optimised {n} images" } },
  description:
    "Losslessly shrink a PNG with oxipng. Pixel data is unchanged, so the image is visually " +
    "identical -- only the file gets smaller. Good for screenshots and UI images. For lossy " +
    "shrinking of photos use image_edit with format webp or avif instead.",
  parameters: Type.Object({
    input: Type.String({ description: "Absolute path to a PNG file" }),
    output: Type.Optional(Type.String({ description: "Output path (default: derived from input)" })),
    level: Type.Optional(Type.Number({ description: "0-6, higher = smaller/slower (default 3)" })),
  }),
  execute: async (args, api) => {
    const t0 = performance.now();
    const src = new Uint8Array(await Bun.file(args.input).arrayBuffer());
    if (sniffFormat(src) !== "png") throw new Error(`image_optimise only handles PNG, got ${args.input}`);

    const raw = await optimisePng(src, { level: Math.max(0, Math.min(Math.round(args.level ?? 3), 6)) });
    const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as Uint8Array).buffer);

    // prove it is still a valid PNG of the same size rather than trusting the optimiser
    const check = await decodePng(bytes) as Decoded;
    const dot = extname(args.input);
    const stem = dot ? args.input.slice(0, -dot.length) : args.input;
    const outPath = await uniquePath(args.output ?? `${stem}_opt.png`);
    await mkdir(dirname(outPath), { recursive: true });
    await Bun.write(outPath, bytes);

    const pct = (1 - bytes.byteLength / src.byteLength) * 100;
    api.output(
      [
        `${args.input} -> ${outPath}`,
        `  ${describeSize(src.byteLength)} -> ${describeSize(bytes.byteLength)} (${pct.toFixed(1)}% smaller)`,
        `  verified decodes ${check.width}x${check.height}`,
        `  total ${(performance.now() - t0) | 0}ms`,
      ].join("\n"),
    );
    return { path: outPath, bytes: bytes.byteLength, saved: src.byteLength - bytes.byteLength, width: check.width, height: check.height };
  },
});

export default defineExtension({
  name: "image-edit",
  tools: [inspectImage, editImage, optimiseImage],
});