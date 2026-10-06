# Pidroid app icon

Artwork for the Android launcher icon (and the web UI favicon).

    bun brand/gen.mjs          # regenerate every layer from TUNE in gen.mjs
    bun brand/gen.mjs --print  # dump the path data only

`gen.mjs` is the source of truth. The `>_" knockout has mitred corners and the
cursor is a stadium, so the coordinates are derived rather than hand-placed —
edit `TUNE`, re-run, and the SVG layers are rewritten. The hand-editable output
is there to be *read*, not nudged.

## Files

| File | Grid | Use |
| --- | --- | --- |
| `pidroid-icon-foreground.svg` | 108×108 | adaptive icon foreground layer |
| `pidroid-icon-background.svg` | 108×108 | adaptive icon background layer |
| `pidroid-icon-monochrome.svg` | 108×108 | Android 13+ themed icons |
| `pidroid-icon.svg` | 108×108 @512 | legacy mipmap / favicon (squircle + mark) |

`www/icon.svg` is a generated copy of `pidroid-icon.svg` — a favicon cannot
reference an external SVG, so it has to be standalone.

## Constraints baked into the geometry

* Adaptive icons are 108dp and the launcher crops the outer 18dp per side, but
  Google's *guaranteed* visible area is the inner **66dp circle** (r=33 about
  54,54). The antenna tips are the tallest art, so they set that budget; the
  layers currently reach r≈32.7.
* No `<mask>`, no filters, no CSS. The knockouts are real subpaths under
  `fill-rule="evenodd"`, so the files import into a VectorDrawable unchanged
  (`fillType="evenOdd"`).
* An arc whose radii are too small for its chord gets scaled up by the SVG
  spec — that silently turned the cursor into a full circle once. It is two
  semicircles now, chord == 2r by construction.

## Getting it onto the launcher

**This part cannot be done from the harness.** The launcher icon lives in the
APK's `res/` tree, inside the Android app module (the Kotlin shell), which is
outside this sandbox — `/data/app` is not even readable from the app. Changing
it means editing the Android project and rebuilding/reinstalling the APK. What
is here is the artwork, ready to drop in.

### Adaptive (recommended, API 26+)

Import the foreground and background SVGs as VectorDrawables (Android Studio:
right-click → New → Vector Asset, or Inkscape → *Save as Android Vector XML*),
then:

```xml
<!-- res/mipmap-anydpi-v26/ic_launcher.xml -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
```

`ic_launcher_round.xml` alongside it with the same contents. `<monochrome>`
(API 33+) needs no `v33` qualifier — it is ignored on older releases.

The background uses a radial gradient; if the VectorDrawable import flattens it
poorly, a solid `#0d0c1a` colour drawable is a fine substitute.

### Legacy (pre-26, and Play Store)

Rasterise `pidroid-icon.svg` to `res/mipmap-*/ic_launcher.png` at
48 / 72 / 96 / 144 / 192 px (mdpi→xxxhdpi), plus 512×512 for the store
listing.

### Without rebuilding

Export the 192px PNG and use an icon pack or a custom launcher that themes
existing packages. That replaces the *displayed* icon only; the installed APK
keeps the old one.

## Colour

| Role | Value |
| --- | --- |
| shell gradient | `#a5b4fc` → `#6366f1` |
| plate | `#241f4d` → `#0d0c1a` → `#000000` |

`#6366f1` is the UI's `--accent`, so the launcher icon and the app agree.
