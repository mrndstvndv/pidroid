## [0.4.1](https://github.com/mrndstvndv/pidroid/compare/v0.4.0...v0.4.1) (2026-10-07)


### Bug Fixes

* **agent:** stop the chat bouncing back up as streamed text arrives ([006a048](https://github.com/mrndstvndv/pidroid/commit/006a048bfec5b84e99426b558e77b965ac993d91))

# [0.4.0](https://github.com/mrndstvndv/pidroid/compare/v0.3.0...v0.4.0) (2026-10-07)


### Bug Fixes

* **agent:** keep a streamed thought open until its step commits ([050a18b](https://github.com/mrndstvndv/pidroid/commit/050a18baea9923014d25957e427507b877407ebc))
* **agent:** stop nesting code-block wrappers while a reply streams ([680b000](https://github.com/mrndstvndv/pidroid/commit/680b00071cfc0b2d5d35a2d6c489f6215ebb94e2))
* **android:** don't let a stop race the off-main-thread agent start ([c1a387e](https://github.com/mrndstvndv/pidroid/commit/c1a387e87b2566728bbe0d5009be9e01b3e0e3fb))


### Features

* **agent:** floating composer card and terminal-style shell calls ([85bd266](https://github.com/mrndstvndv/pidroid/commit/85bd266ce8f64a3f1d3e11842f622d166c7b86ff))
* **agent:** fold tool calls into work groups and add show artifacts ([f57478c](https://github.com/mrndstvndv/pidroid/commit/f57478ccb55578267f8a898fb3d33f75ebb0584d))
* **agent:** keep the Working… row instead of a separate status line ([93b81ca](https://github.com/mrndstvndv/pidroid/commit/93b81ca4bf75b72f8dfb9aaa81a0f82371a79ef4))
* **agent:** model chooser as a floating sheet with a thinking effort page ([0b10624](https://github.com/mrndstvndv/pidroid/commit/0b10624e4d1e825a206aaf0dcf97423947139267))
* **agent:** spring the model sheet in and out with M3 Expressive motion ([74787e3](https://github.com/mrndstvndv/pidroid/commit/74787e32d1995b5564cbaf149e37ea65ba813f5a))

# [0.3.0](https://github.com/mrndstvndv/pidroid/compare/v0.2.0...v0.3.0) (2026-10-07)


### Bug Fixes

* **agent:** exclude deleted sessions from usage totals ([0ea5dda](https://github.com/mrndstvndv/pidroid/commit/0ea5ddaddb14e72086e654b8be6c00f9d2c7e6b7))


### Features

* **agent:** Android bridge support ([5cc6a6d](https://github.com/mrndstvndv/pidroid/commit/5cc6a6dc9bda9624cab1502225c6b72f37c20c70))
* **agent:** copy button on code blocks in chat messages ([da00282](https://github.com/mrndstvndv/pidroid/commit/da00282e9c30c4970de451be81343bd4987a63c5))
* **agent:** opt-in render performance overlay (?perf=1) ([7baddf7](https://github.com/mrndstvndv/pidroid/commit/7baddf793b357f5d5c54ce4a9a34ba1460e79843))
* **agent:** per-response token usage tracking with a usage dashboard ([68ff85c](https://github.com/mrndstvndv/pidroid/commit/68ff85ca01405ca6ebe642a912dcea83ad662539))
* **agent:** record model and thinking changes in the transcript ([875e3e3](https://github.com/mrndstvndv/pidroid/commit/875e3e3bbf39fb79aef19dc6941825ae34772dd6))
* **agent:** warn when the page is talking to the recovery server ([5d56c55](https://github.com/mrndstvndv/pidroid/commit/5d56c55499876013c6b182fa9cc29627a9a558cc))


### Performance Improvements

* **agent:** patch the live tail in place and revalidate static files with ETags ([849b87b](https://github.com/mrndstvndv/pidroid/commit/849b87b68793e9e9330c29ffa58d1c6e5b5e6ed1))
* **agent:** patch the transcript and re-parse only the open paragraph while streaming ([d185c35](https://github.com/mrndstvndv/pidroid/commit/d185c35f4fa5681235eb0cd05a979a5d23718102))
* **agent:** stop animating committed bodies on load and let scroll glides finish on fractional-DPR screens ([e25a4da](https://github.com/mrndstvndv/pidroid/commit/e25a4da73d28219bc41e0d9eaf58a3148645e7fb))
* **agent:** stream only appended text over the WebSocket and stop resending tool views ([37e2cc6](https://github.com/mrndstvndv/pidroid/commit/37e2cc6fa5ab9d0ec1de2682a52653ab1eed7386))
* **agent:** visit only new and still-animating blocks when marking fresh ones ([fccca72](https://github.com/mrndstvndv/pidroid/commit/fccca72eb5e405a25168935bd9a54c05cb8a8625))
* **android:** skip hashing assets on unchanged installs, start the agent off the main thread, defer the startup checkpoint and import extensions in parallel ([938efdb](https://github.com/mrndstvndv/pidroid/commit/938efdbed4e2bddee9b17f1600129fb0d65bd290))

# [0.2.0](https://github.com/mrndstvndv/pidroid/compare/v0.1.0...v0.2.0) (2026-10-06)


### Bug Fixes

* keep bridge LocalSocket referenced so its fd isn't closed by GC ([d6ce2f7](https://github.com/mrndstvndv/pidroid/commit/d6ce2f7dd1e74a0b05217af0db2fd4ef29e4eae1))


### Features

* add Stop agent notification action, native shutdown, and Android bridge ([b5b5f13](https://github.com/mrndstvndv/pidroid/commit/b5b5f137eb504558a00b85eb6ca152bb8ec8ed1a))

# [0.1.0](https://github.com/mrndstvndv/pidroid/compare/v0.0.0...v0.1.0) (2026-10-06)


### Features

* ship an arm64-only, minified release APK ([3776cb0](https://github.com/mrndstvndv/pidroid/commit/3776cb0cd4c5e050cc1d580ea840cbe02f2edc15))
