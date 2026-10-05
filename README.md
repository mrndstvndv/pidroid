# Pidroid

Android app hosting an embedded pi agent (Bun runtime + OpenSSH client shipped as `jniLibs`).

## Releases

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/), driven by
[Conventional Commits](https://www.conventionalcommits.org/).

| Branch | Channel | Version example |
| ------ | ------- | --------------- |
| `main` | stable  | `1.2.0`         |
| `dev`  | prerelease | `1.3.0-dev.1` |

On every push to `main`/`dev` the **Release** workflow analyses commits since the last tag. If a release is
warranted it stamps `version` in `gradle.properties`, builds the signed APK (`pidroid-<version>.apk`), commits
`CHANGELOG.md` + `gradle.properties`, tags, publishes a GitHub release, and back-merges `main` into `dev`.
Pushes to `dev` also open a draft PR `dev` -> `main`. Pull requests run the **Build** workflow.
CI needs JDK 17 and Bun (the `:app:bundleAgent` Gradle task runs `bun install --frozen-lockfile` and `bun build`).
`app/tools/openssh/` is a local tool; its outputs are committed under `app/src/main/jniLibs` and CI never runs it.

### Commit rules (from now on)

The history before this setup is not conventional (`peak`, `Host the embedded agent: ...`) and is left as is.
**No release is created until a `feat:` or `fix:` commit lands** after the setup. Use:

- `feat: ...` -> minor release
- `fix: ...`, `perf: ...` -> patch release
- `feat!: ...` or a `BREAKING CHANGE:` footer -> major release
- `docs:`, `chore:`, `ci:`, `refactor:`, `test:`, `style:`, `build:` -> no release

Releases start from `0.0.0`, so the first `feat:` gives `0.1.0` and the first `fix:` gives `0.0.1`.

### One-time owner setup

1. Generate a release keystore locally: `./generate-keystore.sh` (creates `release.jks` and `keystore.properties`,
   both git-ignored). Back it up somewhere safe; losing it means users cannot update.
2. Add four repo secrets (Settings -> Secrets and variables -> Actions):
   `KEYSTORE_BASE64` (`base64 -i release.jks | pbcopy` on macOS, `base64 -w0 release.jks` on Linux),
   `KEYSTORE_PASS`, `KEY_ALIAS`, `KEY_PASS`.
3. Settings -> Actions -> General -> Workflow permissions: allow read and write, and allow Actions to create pull requests.
4. Create `dev` from `main` when you want a prerelease channel: `git branch dev main && git push origin dev`.
5. Optional: protect `main` (require the Build check). If you do, allow the release bot to push the release commit
   (semantic-release pushes `chore: Release vX [skip ci]` to `main`).

Local release build: put `keystore.properties` at the repo root and run `./gradlew assembleRelease`.
