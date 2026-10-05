#!/usr/bin/env python3
"""
Builds the OpenSSH client the app ships, from Termux's prebuilt aarch64 packages.

Why: @earendil-works/pi-env reaches remote machines by spawning the system `ssh` (OpenSSH flags: BatchMode,
ControlPath=none, UserKnownHostsFile, HostKeyAlias, ...) and `ssh-keygen -lf`. Android has no ssh client and an app
cannot run another app's binaries, so the app brings its own.

What it does (deterministic: every input is pinned by version and SHA-256 below):
  1. downloads the pinned Termux .deb packages and verifies each checksum;
  2. extracts ssh, ssh-keygen and the shared libraries they link;
  3. renames them to lib*.so (Android only packages files with that name pattern) and rewrites DT_NEEDED / SONAME
     to match, and sets RUNPATH to $ORIGIN so the linker finds the siblings in the app's native library directory;
  4. checks that every remaining dependency is an Android system library or one of the shipped files;
  5. writes the result to app/src/main/jniLibs/arm64-v8a/ and a manifest of output SHA-256s.

Requires `patchelf` on PATH, e.g.:   nix shell nixpkgs#patchelf -c python3 app/tools/openssh/build.py

Termux builds are dynamically linked against Termux's own libraries, which is why the closure is 14 files (about
9 MB): OpenSSL (libcrypto/libssl), ldns, zlib, Kerberos (libgssapi_krb5 and friends) and small Android shims.
Licenses: OpenSSH is BSD, OpenSSL Apache-2.0, MIT Kerberos is a permissive MIT-style license; see THIRD_PARTY.md.
"""

import glob
import hashlib
import io
import lzma
import gzip
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request

REPO = "https://packages.termux.dev/apt/termux-main/"

# name -> (pool path, version, sha256). Termux's apt index is the source of these checksums.
PACKAGES = {
    "openssh": ("pool/main/o/openssh/openssh_10.5p1_aarch64.deb", "10.5p1", "110dcebd42eb4d147d7fdd132f8834e5cb5ff355ef9ed80385ad33698c984ebe"),
    "openssl": ("pool/main/o/openssl/openssl_1:3.6.5_aarch64.deb", "1:3.6.5", "a2fb7856875e63ef6b90442752e05974813372c3ca86d2513a78ea43c67a0f8b"),
    "ldns": ("pool/main/l/ldns/ldns_1.9.2_aarch64.deb", "1.9.2", "fcc8feb86be077e59cb3fd1f05867061ea1e985b11a36d30603ce1cdecd6b68a"),
    "zlib": ("pool/main/z/zlib/zlib_1.3.2_aarch64.deb", "1.3.2", "75e7d0af17fcc3b40004309fdc00a1ddb9ae08346dce5e269902c34ac3966ac9"),
    "libandroid-support": ("pool/main/liba/libandroid-support/libandroid-support_29-1_aarch64.deb", "29-1", "f2f145d6135ad4843ac9670153be3e3944dc1e6f1736d46d2306c28f2b86f517"),
    "krb5": ("pool/main/k/krb5/krb5_1.22.2_aarch64.deb", "1.22.2", "3c97dcc7437616bb4051297822915bd2ff9552e63a5fbee2520db3fc0c5b575d"),
    "libandroid-glob": ("pool/main/liba/libandroid-glob/libandroid-glob_0.6-3_aarch64.deb", "0.6-3", "2276ae8adedf0db76c2f4ffc94cc4cceb2f4f5d78e021b54e2e046d1233e7826"),
    "libresolv-wrapper": ("pool/main/libr/libresolv-wrapper/libresolv-wrapper_1.1.8_aarch64.deb", "1.1.8", "41c989a4c6f85575ac542ab5d710fead6fec4cb41941f634666a68a765c13370"),
}

# Libraries Android itself provides; everything else must be shipped.
SYSTEM = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libstdc++.so", "libandroid.so"}

# Executables to ship -> output name.
EXECUTABLES = {"ssh": "libopenssh_ssh.so", "ssh-keygen": "libopenssh_keygen.so"}

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "main", "jniLibs", "arm64-v8a"))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(name: str) -> str:
    pool, _version, want = PACKAGES[name]
    dest = os.path.join(CACHE, f"{name}.deb")
    if not os.path.exists(dest):
        os.makedirs(CACHE, exist_ok=True)
        with urllib.request.urlopen(REPO + urllib.parse.quote(pool), timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    got = sha256(open(dest, "rb").read())
    if got != want:
        sys.exit(f"checksum mismatch for {name}: got {got}, pinned {want}")
    return dest


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


def shipped_name(soname: str) -> str:
    """libcrypto.so.3 -> libcrypto_3.so ; names already ending in .so are kept."""
    if soname.endswith(".so"):
        return soname
    m = re.match(r"^(lib.+)\.so\.(.+)$", soname)
    if not m:
        sys.exit(f"cannot derive a lib*.so name from {soname}")
    return f"{m.group(1)}_{m.group(2).replace('.', '_')}.so"


def main() -> None:
    if shutil.which("patchelf") is None:
        sys.exit("patchelf not found; run: nix shell nixpkgs#patchelf -c python3 " + os.path.relpath(__file__))

    tree = os.path.join(CACHE, "tree")
    shutil.rmtree(tree, ignore_errors=True)
    for name in PACKAGES:
        extract_deb(fetch(name), os.path.join(tree, name))
        print(f"ok  {name} {PACKAGES[name][1]}")

    # Index every shared library by the file name (and soname) other files ask for.
    libs: dict[str, str] = {}
    for path in glob.glob(os.path.join(tree, "*", "data", "data", "com.termux", "files", "usr", "lib", "**", "*"), recursive=True):
        base = os.path.basename(path)
        if ".so" in base and os.path.isfile(path):
            libs.setdefault(base, os.path.realpath(path))
    bins = {n: os.path.join(tree, "openssh", "data", "data", "com.termux", "files", "usr", "bin", n) for n in EXECUTABLES}

    # Closure of DT_NEEDED from the executables.
    order: list[str] = []
    source: dict[str, str] = {}
    queue = list(EXECUTABLES)
    for n in queue:
        source[n] = bins[n]
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

    rename = {n: (EXECUTABLES[n] if n in EXECUTABLES else shipped_name(n)) for n in order}

    # Never wipe jniLibs: libbun.so lives there. Only our own libopenssh_*.so outputs are replaced below.
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, "libopenssh_*.so")):
        os.remove(old)

    produced: dict[str, str] = {}
    for n in order:
        dest = os.path.join(OUT, rename[n])
        shutil.copyfile(source[n], dest)
        os.chmod(dest, 0o755)
        for dep in patchelf("--print-needed", dest).split():
            if dep in rename and rename[dep] != dep:
                patchelf("--replace-needed", dep, rename[dep], dest)
        if n not in EXECUTABLES and rename[n] != n:
            patchelf("--set-soname", rename[n], dest)
        patchelf("--set-rpath", "$ORIGIN", dest)  # siblings live next to the binary in nativeLibraryDir
        produced[rename[n]] = sha256(open(dest, "rb").read())

    # Verify the artifact, not the intent: every NEEDED is a system lib or a shipped file.
    for name in produced:
        for dep in patchelf("--print-needed", os.path.join(OUT, name)).split():
            if dep not in SYSTEM and dep not in produced:
                sys.exit(f"{name} still needs {dep}")

    with open(os.path.join(HERE, "MANIFEST.txt"), "w") as f:
        f.write("# Inputs (Termux apt, aarch64) and outputs (jniLibs/arm64-v8a); regenerate with build.py\n")
        for name, (pool, version, digest) in PACKAGES.items():
            f.write(f"input  {name} {version} sha256={digest}\n")
        for name, digest in sorted(produced.items()):
            f.write(f"output {name} sha256={digest}\n")
    print(f"\nwrote {len(produced)} files to {OUT}")
    for name in sorted(produced):
        print(f"  {name:28} {os.path.getsize(os.path.join(OUT, name)):>9} B")


if __name__ == "__main__":
    main()
