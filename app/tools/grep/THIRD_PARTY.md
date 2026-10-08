# Bundled GNU grep

The app ships GNU grep so the agent's shell has `grep`, `egrep` and `fgrep`. It is built by `build.py` from Termux's
prebuilt aarch64 packages (https://packages.termux.dev/apt/termux-main/), each pinned by version and SHA-256 in
`build.py` and recorded with the output hashes in `MANIFEST.txt`.

| Component | Version | License | License text |
|---|---|---|---|
| GNU grep (`grep`, shipped as `libgrep.so`) | 3.12 (Termux 3.12-3) | GPL-3.0-or-later | licenses/grep.COPYING |
| PCRE2 (`libpcre2-8.so`) | 10.49 | BSD-3-Clause WITH PCRE2-exception | licenses/pcre2.LICENCE.md |
| libandroid-support (`libandroid-support.so`) | 29-1 | Apache-2.0 | licenses/libandroid-support.copyright |

`libandroid-support.so` is the same file the OpenSSH build ships (app/tools/openssh), byte for byte, so this build
does not rewrite it.

**GPL source offer.** GNU grep is GPL-3.0-or-later. Anyone who receives the APK is owed the corresponding source of
grep (GPL-3.0 section 6). Upstream source: https://ftp.gnu.org/gnu/grep/ (version 3.12). Termux's build recipes are in
https://github.com/termux/termux-packages.

**GPL text.** The grep package's `copyright` file is a link to `../../LICENSES/GPL-3.0.txt`, which the `.deb` does not
ship. `licenses/grep.COPYING` is the GPL-3.0 text from https://www.gnu.org/licenses/gpl-3.0.txt, pinned by SHA-256
in `build.py`.

**egrep and fgrep** are not shipped. Termux's copies are shell scripts that run `/data/data/com.termux/...`, which does
not exist on the phone. `AgentProcessManager` links both names to `libgrep.so` on PATH, and GNU grep selects `-E` or
`-F` from the name it was started under.

Binaries are shipped unmodified except for `patchelf` edits: grep becomes `libgrep.so`, and RUNPATH is set to
`$ORIGIN` so the linker finds `libpcre2-8.so` and `libandroid-support.so` in the app's native library directory.
Termux's RUNPATH is `/data/data/com.termux/files/usr/lib`, which does not exist on the device.

Only arm64-v8a is built. Regenerate with: `nix shell nixpkgs#patchelf -c python3 app/tools/grep/build.py`
