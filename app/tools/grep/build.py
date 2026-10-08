#!/usr/bin/env python3
"""
Builds the GNU grep the agent's shell ships, from Termux's prebuilt aarch64 packages.

Why: an app can only execute files from its native library directory (labelled apk_data_file). A grep copied into the
app's data directory fails with EACCES, so grep is bundled in the APK the same way OpenSSH is (app/tools/openssh).
AgentProcessManager links grep, egrep and fgrep to libgrep.so on PATH. GNU grep picks its mode from argv[0], so the
two links need no binaries of their own; Termux's egrep and fgrep are shell scripts that point at /data/data/com.termux,
so they are not shipped.

What it does (deterministic: every input is pinned by version and SHA-256 below):
  1. downloads the pinned Termux .deb packages and the GPL-3.0 text, and verifies each checksum;
  2. extracts bin/grep and the shared libraries it links (libpcre2-8.so, libandroid-support.so);
  3. renames grep to libgrep.so and sets RUNPATH to $ORIGIN, so the linker finds the siblings in the app's native library
     directory (Termux's RUNPATH is /data/data/com.termux/files/usr/lib, which does not exist on the phone);
  4. checks the artifact: every DT_NEEDED is an Android system library or a shipped file, RUNPATH is $ORIGIN and the
     interpreter is /system/bin/linker64;
  5. copies the licence texts into licenses/;
  6. writes each output to app/src/main/jniLibs/arm64-v8a/ only if its bytes differ, and a manifest of SHA-256s.

Requires `patchelf` on PATH, e.g.:   nix shell nixpkgs#patchelf -c python3 app/tools/grep/build.py
The binary is an Android executable, so this checks it statically only; it cannot be run on the build machine.
"""

import glob
import gzip
import hashlib
import io
import lzma
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request

REPO = "https://packages.termux.dev/apt/termux-main/"

# name -> (pool path, version, sha256). Termux's apt index is the source of these checksums.
PACKAGES = {
    "grep": ("pool/main/g/grep/grep_3.12-3_aarch64.deb", "3.12-3", "a2819b49c621b61567e39c5c647d5ed6fe9d51eab71ed73eebf18be76719457d"),
    "pcre2": ("pool/main/p/pcre2/pcre2_10.49_aarch64.deb", "10.49", "c27995e5f52b8ecc9b8b3e662eb08e49f82a18bfd3f34343936acc7b23964724"),
    "libandroid-support": ("pool/main/liba/libandroid-support/libandroid-support_29-1_aarch64.deb", "29-1", "f2f145d6135ad4843ac9670153be3e3944dc1e6f1736d46d2306c28f2b86f517"),
}

# The grep package's copyright file is a dangling link to ../../LICENSES/GPL-3.0.txt, which the .deb does not ship.
GPL_URL = "https://www.gnu.org/licenses/gpl-3.0.txt"
GPL_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"

# Libraries Android itself provides; everything else must be shipped.
SYSTEM = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libstdc++.so", "libandroid.so"}

# Executables to ship -> output name.
EXECUTABLES = {"grep": "libgrep.so"}

# Licence texts to copy out of the packages: name -> (path under the package's usr/, output name in licenses/).
LICENCES = {
    "pcre2": ("share/doc/pcre2/LICENCE.md", "pcre2.LICENCE.md"),
    "libandroid-support": ("share/doc/libandroid-support/LICENSE.txt", "libandroid-support.copyright"),
}

PREFIX = os.path.join("data", "data", "com.termux", "files", "usr")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
LICENSES = os.path.join(HERE, "licenses")
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "main", "jniLibs", "arm64-v8a"))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str, dest: str, want: str) -> str:
    if not os.path.exists(dest):
        os.makedirs(CACHE, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    got = sha256(open(dest, "rb").read())
    if got != want:
        sys.exit(f"checksum mismatch for {url}: got {got}, pinned {want}")
    return dest


def fetch(name: str) -> str:
    pool, _version, want = PACKAGES[name]
    return download(REPO + urllib.parse.quote(pool), os.path.join(CACHE, f"{name}.deb"), want)


def extract_deb(deb: str, out: str) -> None:
    """Minimal .deb (ar) reader; extracts the data tarball into `out`."""
    raw = open(deb, "rb").read()
    assert raw[:8] == b"!<arch>\n"
    pos = 8
    while pos < len(raw):
        header = raw[pos : pos + 60]
        pos += 60
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58].decode().strip())
        body = raw[pos : pos + size]
        pos += size + (size & 1)
        if name.startswith("data.tar"):
            if name.endswith(".xz"):
                body = lzma.decompress(body)
            elif name.endswith(".gz"):
                body = gzip.decompress(body)
            os.makedirs(out, exist_ok=True)
            with tarfile.open(fileobj=io.BytesIO(body)) as tar:
                tar.extractall(out, filter="tar")


def patchelf(*args: str) -> str:
    return subprocess.run(["patchelf", *args], check=True, capture_output=True, text=True).stdout.strip()


def main() -> None:
    if shutil.which("patchelf") is None:
        sys.exit("patchelf not found; run: nix shell nixpkgs#patchelf -c python3 " + os.path.relpath(__file__))

    tree = os.path.join(CACHE, "tree")
    shutil.rmtree(tree, ignore_errors=True)
    for name in PACKAGES:
        extract_deb(fetch(name), os.path.join(tree, name))
        print(f"ok  {name} {PACKAGES[name][1]}")
    gpl = download(GPL_URL, os.path.join(CACHE, "gpl-3.0.txt"), GPL_SHA256)

    # Index every shared library by the file name other files ask for.
    libs: dict[str, str] = {}
    for path in glob.glob(os.path.join(tree, "*", PREFIX, "lib", "**", "*"), recursive=True):
        base = os.path.basename(path)
        if ".so" in base and os.path.isfile(path):
            libs.setdefault(base, os.path.realpath(path))

    # Closure of DT_NEEDED from grep.
    source: dict[str, str] = {"grep": os.path.join(tree, "grep", PREFIX, "bin", "grep")}
    order: list[str] = []
    queue = ["grep"]
    seen: set[str] = set()
    while queue:
        n = queue.pop(0)
        if n in seen:
            continue
        seen.add(n)
        order.append(n)
        for dep in patchelf("--print-needed", source[n]).split():
            if dep in SYSTEM:
                continue
            if dep not in libs:
                sys.exit(f"{n} needs {dep}, which is neither an Android system library nor in the pinned packages")
            source[dep] = libs[dep]
            queue.append(dep)

    # Patch copies in the cache, so jniLibs only ever receives a finished, checked file.
    stage = os.path.join(CACHE, "out")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    produced: dict[str, bytes] = {}
    for n in order:
        name = EXECUTABLES.get(n, n)
        path = os.path.join(stage, name)
        shutil.copyfile(source[n], path)
        os.chmod(path, 0o755)
        patchelf("--set-rpath", "$ORIGIN", path)  # siblings live next to the binary in nativeLibraryDir
        produced[name] = open(path, "rb").read()

    # Verify the artifact, not the intent: every NEEDED is a system lib or a shipped file, and the loader settings are right.
    for name in produced:
        path = os.path.join(stage, name)
        for dep in patchelf("--print-needed", path).split():
            if dep not in SYSTEM and dep not in produced:
                sys.exit(f"{name} still needs {dep}")
        rpath = patchelf("--print-rpath", path)
        if rpath != "$ORIGIN":
            sys.exit(f"{name} has RUNPATH {rpath!r}, expected '$ORIGIN'")
    interp = patchelf("--print-interpreter", os.path.join(stage, "libgrep.so"))
    if interp != "/system/bin/linker64":
        sys.exit(f"libgrep.so has interpreter {interp!r}, expected /system/bin/linker64")

    # Write only the outputs whose bytes changed, so an identical library keeps its file.
    os.makedirs(OUT, exist_ok=True)
    for name, data in sorted(produced.items()):
        dest = os.path.join(OUT, name)
        if os.path.exists(dest) and open(dest, "rb").read() == data:
            print(f"same  {name}")
            continue
        shutil.copyfile(os.path.join(stage, name), dest)
        os.chmod(dest, 0o755)
        print(f"wrote {name}")

    os.makedirs(LICENSES, exist_ok=True)
    shutil.copyfile(gpl, os.path.join(LICENSES, "grep.COPYING"))
    for name, (member, out) in LICENCES.items():
        shutil.copyfile(os.path.join(tree, name, PREFIX, member), os.path.join(LICENSES, out))

    with open(os.path.join(HERE, "MANIFEST.txt"), "w") as f:
        f.write("# Inputs (Termux apt, aarch64; gnu.org) and outputs (jniLibs/arm64-v8a); regenerate with build.py\n")
        for name, (pool, version, digest) in PACKAGES.items():
            f.write(f"input  {name} {version} sha256={digest}\n")
        f.write(f"input  gpl-3.0.txt sha256={GPL_SHA256}\n")
        for name, data in sorted(produced.items()):
            f.write(f"output {name} sha256={sha256(data)}\n")
    print(f"\nchecked {len(produced)} files in {OUT}")
    for name in sorted(produced):
        print(f"  {name:28} {len(produced[name]):>9} B  {sha256(produced[name])}")


if __name__ == "__main__":
    main()
