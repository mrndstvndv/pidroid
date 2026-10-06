# Task: replace the stock launcher icon with the Pidroid mark

You are working in the **Pidroid** Android app repo at `/Volumes/realme/Dev/pidroid`
(Gradle/Kotlin, package `com.mrndstvndv.pidroid`). The app is an Android WebView
shell around a Bun server that serves a web UI from `www/`.

The current launcher icon is the **unmodified Android Studio template**
(`res/drawable/ic_launcher_foreground.xml`, stock vector). Replace it with the
finished artwork in `brand/`.

## Source artwork (already in the repo)

| File | Grid | Purpose |
| --- | --- | --- |
| `brand/pidroid-icon-foreground.svg` | 108×108 | adaptive foreground layer |
| `brand/pidroid-icon-background.svg` | 108×108 | adaptive background layer |
| `brand/pidroid-icon-monochrome.svg` | 108×108 | themed-icon layer |
| `brand/pidroid-icon.svg` | 108×108 @512 | standalone squircle mark, for raster output |

`brand/gen.mjs` is the **generator and source of truth** for the geometry — the
`>_` knockout has mitred corners and the cursor is a stadium, so the coordinates
are derived, not hand-placed. `bun brand/gen.mjs` rewrites all four SVGs from its
`TUNE` block; `--print` dumps the path data. If the artwork needs adjusting, change
`TUNE` and re-run rather than editing SVG numbers by hand. `brand/README.md` has the
original drop-in notes.

## What to do

1. **Convert each layer to an Android VectorDrawable** at `android:viewportWidth="108"`
   / `android:viewportHeight="108"`, `android:width/height="108dp"`:
   - `res/drawable/ic_launcher_foreground.xml`
   - `res/drawable/ic_launcher_background.xml`
   - `res/drawable/ic_launcher_monochrome.xml` *(new)*

2. **Gradients.** The foreground shell is a vertical linear gradient
   `#a5b4fc → #6366f1`, expressed with `<aapt:attr name="android:fillColor">` and a
   `<gradient android:type="linear">`. The background is a **radial** gradient
   `#241f4d → #0d0c1a → #000000`. Android VectorDrawable gradients support radial via
   `android:type="radial"` + `gradientRadius`; if that proves troublesome, fall back
   to a linear or a flat `#0d0c1a` background and **say so in your report** — do not
   silently drop it.

3. **Knockouts.** The `>_` is knocked out of the head with two extra subpaths in the
   same `<path>`. That requires `android:fillType="evenOdd"`. Getting this wrong makes
   the glyph render as filled-in ink instead of holes, so double-check it.

4. **Safe zone.** All art must stay within **r=33 of (54,54)** — the 66dp circle Android
   guarantees visible, not the r=36 crop boundary. The antenna tips are the binding
   constraint; the artwork currently reaches r≈32.7. Measure it from the actual path
   data and confirm, rather than assuming.

5. **Fix the themed-icon reference.** `res/mipmap-anydpi-v26/ic_launcher.xml` and
   `ic_launcher_round.xml` currently have `<monochrome android:drawable="@drawable/ic_launcher_foreground" />`
   — pointing the themed layer at the *coloured* foreground. Point it at the new
   `@drawable/ic_launcher_monochrome` instead. Leave `AndroidManifest.xml` alone; it
   already references `@mipmap/ic_launcher` and `@mipmap/ic_launcher_round`.

6. **Legacy rasters.** Replace the stock `.webp` files in `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}`
   (48/72/96/144/192 px) with renders of `brand/pidroid-icon.svg`. This Mac has **no**
   ImageMagick, rsvg-convert or Inkscape; `python3` and `qlmanage` are available —
   use whichever actually produces correct output and verify the dimensions afterwards
   (`sips -g pixelWidth -g pixelHeight`). Adaptive icons cover API 26+, so these are
   only for very old launchers, but they should still not show the template.

7. **Verify it builds.** Run the Gradle build (`./gradlew :app:assembleDebug`, or the
   release variant if that is what this repo actually uses) and report whether it
   compiles clean.

## Hard constraints

- **Do NOT run `adb install` or otherwise put the APK on the phone.** The phone is
  currently running this very session inside that app; replacing it would kill the
  work in progress. Build only.
- **Do not push.** Leave the changes in the working tree for review. Do not commit
  either — the human will decide what to keep, and `brand/` may want to stay untracked.
- Do not reformat or restructure anything unrelated. This is an icon change.

## Report back

- exact list of files created/modified/deleted
- the Gradle build result (success/failure, and the error if any)
- any deviation from the source artwork and why
- confirmation of the safe-zone measurement
- anything you had to guess at, so it can be checked