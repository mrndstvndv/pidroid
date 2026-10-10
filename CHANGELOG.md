# [1.0.0](https://github.com/mrndstvndv/pidroid/compare/v0.6.0...v1.0.0) (2026-10-10)


* feat(agent)!: run the agent bundle read-only and drop self-modification ([9440aed](https://github.com/mrndstvndv/pidroid/commit/9440aed6147768394bbbfb0e0818b21e6b079c91))


### Bug Fixes

* **agent:** keep the system prompt to the environment, tools and skills ([b1a251c](https://github.com/mrndstvndv/pidroid/commit/b1a251cedbc0d718688f65e0141574fa0154b901))
* **agent:** tell the agent how updates work and drop stale prompt lines ([e80e714](https://github.com/mrndstvndv/pidroid/commit/e80e714211ef2065dce91beb0dfdbf2ad042ef4c))
* **app:** stop the agent service on task removal when no agent is running ([ee64d93](https://github.com/mrndstvndv/pidroid/commit/ee64d93679a6fbacd0e1b77409a7cd28bf9fefaa))


### Features

* **agent:** add an Updates tab for bundle status, import and rollback ([dffab50](https://github.com/mrndstvndv/pidroid/commit/dffab50fffcba75de64ad30542d61dbf9bc234cc))
* **app:** check GitHub releases for agent bundles and apply them when idle ([51394f3](https://github.com/mrndstvndv/pidroid/commit/51394f397f2a1727fc63fd7bbb792a156f54f80e))
* **app:** run immutable agent bundles with trial and rollback ([0be2dd2](https://github.com/mrndstvndv/pidroid/commit/0be2dd22630871c0087268552a4ef1abc940f564))


### BREAKING CHANGES

* the agent can no longer edit the app's own source.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BMq1pUPAG5m8RHdjboUYkp

# [0.6.0](https://github.com/mrndstvndv/pidroid/compare/v0.5.0...v0.6.0) (2026-10-10)


### Bug Fixes

* **agent:** bundle manifest, concurrent exports and skill discovery ([669d867](https://github.com/mrndstvndv/pidroid/commit/669d8673047912987aa939e87ae8a02fa1f6b953))
* **agent:** code and diff viewers render, read and wrap properly ([955d6cc](https://github.com/mrndstvndv/pidroid/commit/955d6ccaf365f837fdd1323c260030495710f8af))
* **agent:** diff ghost line, Zen's Off level, and bounded highlighting ([02494da](https://github.com/mrndstvndv/pidroid/commit/02494da360a0fd732b2b98b602b4f9058b4e8b49))
* **agent:** only the reader's input can stop the chat following the stream ([5584896](https://github.com/mrndstvndv/pidroid/commit/558489687648ac1f60c4200a33964440d15e5591))
* **agent:** repair OpenCode's off level and make send and stop neutral ([6a34c32](https://github.com/mrndstvndv/pidroid/commit/6a34c32591efc1a012184c2ce81febeefe5fec77))
* **agent:** steady status row, run clock and session landing ([22ed586](https://github.com/mrndstvndv/pidroid/commit/22ed58654c5d123a4e0764d95e00eeb4d18d1963))


### Features

* **agent:** Agent Skills tab and an Export bundle button ([00e94d5](https://github.com/mrndstvndv/pidroid/commit/00e94d532193f9b5361989eb7dfd211d66ca2abe))
* **agent:** checkpoint chosen paths and reconcile app updates in git ([9ee7601](https://github.com/mrndstvndv/pidroid/commit/9ee7601d36158fe7dd90f4255ab189f85bb97e9a))
* **agent:** colour code fences inside Markdown files by their own language ([2888cd4](https://github.com/mrndstvndv/pidroid/commit/2888cd4116b22e95ad4b6dea24915b12b40fcbce))
* **agent:** dock the run status and queued messages above the composer ([2582f06](https://github.com/mrndstvndv/pidroid/commit/2582f0642fe061697c1d26f366560f3f4102d0f1))
* **agent:** follow the transcript tail by native scroll anchoring ([920826c](https://github.com/mrndstvndv/pidroid/commit/920826c083c676aa8df2e7426eb0f9f711ea83c6))
* **agent:** keep transcript nodes across a commit ([2d5a1ee](https://github.com/mrndstvndv/pidroid/commit/2d5a1eec7efbb7e14ade36b4022b54a871aa0cfb))
* **agent:** merge phone updates and switch session machines ([172d5ce](https://github.com/mrndstvndv/pidroid/commit/172d5ceac7a385ef8f68524e973afa67f38838a2))
* **agent:** one code viewer for files and diffs, with soft wrap ([92b1b02](https://github.com/mrndstvndv/pidroid/commit/92b1b022609d4baa97701fce584ede6e7427f89b))
* **agent:** one markdown renderer for streaming, committed and thinking text ([e3169e9](https://github.com/mrndstvndv/pidroid/commit/e3169e96b29654939a223a20275ba87c70d5cc33))
* **agent:** pace streamed text to an even reveal ([5902a3a](https://github.com/mrndstvndv/pidroid/commit/5902a3ab74f1936317f5c402b4369ac8bd6f4a0c))
* **agent:** run a session's tools on a machine over SSH ([247a281](https://github.com/mrndstvndv/pidroid/commit/247a28179220784c8f7d5a5acffc29da0ce5f102))
* **agent:** slide new transcript lines in on the compositor ([ea39a9f](https://github.com/mrndstvndv/pidroid/commit/ea39a9f5436f5650d85a41978036fffd37483c7f))
* **agent:** syntax highlighting for files, diffs and code fences ([ffb142c](https://github.com/mrndstvndv/pidroid/commit/ffb142c82ebc44a6f2db86a1e0a4d7f3a7cbd4b7))
* **agent:** title popup, code ligatures and bundled JetBrains Mono ([9a6cc17](https://github.com/mrndstvndv/pidroid/commit/9a6cc17e8643f16c270d31b85a27c44877a1fed8))
* **agent:** tool-call diffs with gutters, one turn total, tweened groups and a Mono theme ([5364a9c](https://github.com/mrndstvndv/pidroid/commit/5364a9c3c8fb9a0ceaf1cad3635af49114c1124d))
* **android:** bundle GNU grep for the agent sandbox ([59deaea](https://github.com/mrndstvndv/pidroid/commit/59deaea508b9ea03a0ad579ee264f7a6704b1902))


### Performance Improvements

* **agent:** count visual drops of the last transcript block per frame ([c43db45](https://github.com/mrndstvndv/pidroid/commit/c43db456ef01fdd01143b44f8cf9bbc211094d32))
* **agent:** load a diff's folded lines when the fold is tapped ([b1b75ec](https://github.com/mrndstvndv/pidroid/commit/b1b75ecefd16f1487d3e2e4667eab7903bf23e33))

# [0.5.0](https://github.com/mrndstvndv/pidroid/compare/v0.4.1...v0.5.0) (2026-10-07)


### Bug Fixes

* **agent:** follow the stream by reader intent, not scroll offset ([4a23de1](https://github.com/mrndstvndv/pidroid/commit/4a23de1ab0da76afafd418160fd4cfabb542d9b1))
* **agent:** hide OpenCode free models that Zen no longer serves ([743e04d](https://github.com/mrndstvndv/pidroid/commit/743e04db3e9f2534a9d4ec0416acf10d7a855f24))
* **agent:** keep the newest message in view when the viewport shrinks ([e94bd2a](https://github.com/mrndstvndv/pidroid/commit/e94bd2ab8e4ccfeb6d72b7f20037d3a8f966324e))
* **agent:** re-measure the composer when the chat screen returns ([77823b2](https://github.com/mrndstvndv/pidroid/commit/77823b2fb04ae94ae770d95a6ea1f4259fb56637))


### Features

* **agent:** add a shared token-count formatter ([8769a39](https://github.com/mrndstvndv/pidroid/commit/8769a39f029156e8a8a13cd8149e551e9818bec3))
* **agent:** artifact card rendering, branch chip and thinking status UI tweaks ([c0701b4](https://github.com/mrndstvndv/pidroid/commit/c0701b44170ef28587c2d47b76d229e4776a2368))
* **agent:** copy or export a session transcript from its menu ([e31d211](https://github.com/mrndstvndv/pidroid/commit/e31d211ac09b1d776908773b783ef82a3b0a8faa))
* **agent:** export a session transcript as Markdown and JSON ([fbeffe4](https://github.com/mrndstvndv/pidroid/commit/fbeffe4bed1ac5fb3e5b95e3065d6ae15cfb6678))
* **agent:** pick the title model from the model chooser sheet ([118c3e9](https://github.com/mrndstvndv/pidroid/commit/118c3e97026784526c88e3ce0d698a26dd869068))
* **agent:** show session title generation as in-app toasts ([11427c9](https://github.com/mrndstvndv/pidroid/commit/11427c9e0b3c1c2cd09ac1d1eb67058200368ee1))

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
