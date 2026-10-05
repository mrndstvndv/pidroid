# Bundled OpenSSH client

The app ships an OpenSSH client so `@earendil-works/pi-env` can reach remote machines. It is built by `build.py`
from Termux's prebuilt aarch64 packages (https://packages.termux.dev/apt/termux-main/), each pinned by version and
SHA-256 in `build.py` and recorded with the output hashes in `MANIFEST.txt`.

| Component | Version | License |
|---|---|---|
| OpenSSH (`ssh`, `ssh-keygen`) | 10.5p1 | BSD-style (see licenses/openssh.copyright) |
| OpenSSL (`libcrypto`, `libssl`) | 3.6.5 | Apache-2.0 |
| ldns | 1.9.2 | BSD |
| MIT Kerberos (`libgssapi_krb5` and friends) | 1.22.2 | MIT-style |
| zlib | 1.3.2 | zlib |
| libandroid-support, libandroid-glob, libresolv-wrapper | 29-1, 0.6-3, 1.1.8 | see licenses/ |

The upstream copyright files from each package are in `licenses/`. Binaries are shipped unmodified except for
`patchelf` renames (`lib*.so` names, SONAME/NEEDED, RUNPATH=$ORIGIN) so Android's packager and linker accept them.

Only arm64-v8a is built. Regenerate with: `nix shell nixpkgs#patchelf -c python3 app/tools/openssh/build.py`
