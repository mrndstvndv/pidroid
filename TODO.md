# TODO

## Now: pi wiring

Android client for pi, talking to `pi-bridge` (`/Volumes/realme/Dev/pi-bridge`) over WebSocket.

- [ ] WS client: `ws://<host>:8787/ws?cwd=<abs>&session=<recent|path>&[name=]`, wait for `ready` before sending
- [ ] Protocol models mirroring `pi --mode rpc`: `prompt`, `steer`, `follow_up`, `abort`, `new_session`,
      `switch_session`, `fork`, `clone`, `get_state`, `get_messages`, `get_entries`, `set_model`,
      `set_thinking_level`, `compact`, `set_auto_compaction`, `bash`/`abort_bash`, `export_html`
- [ ] Stream events: `message_update` (`text_delta`), `tool_execution_start/update/end`,
      `agent_settled`, `turn_start`/`turn_end`, `queue_update`, `extension_error`
- [ ] Extension UI dialogs: `extension_ui_request` (select/confirm/input/notify) -> `extension_ui_response`.
      Dialogs with a `timeout` auto-resolve server-side, so the UI must tolerate that.
- [ ] Connection screen using HTTP discovery: `GET /api/status`, `/api/sessions?cwd=`, `/api/dirs?q=`
- [ ] No auth on the bridge today (binds `0.0.0.0`) - decide token/mTLS before shipping

## Later: ACP support (multi-agent)

Keep pi-only for now; add ACP only if multi-agent becomes a requirement. Notes from research, Sep 2026:

- SDK: `com.agentclientprotocol:acp` - Kotlin Multiplatform, JVM-only target today, consumed as the
  `acp-jvm` variant (no `androidTarget`). Maven Central at `0.30.1`; GitHub tags ahead (`v0.32.0`). Pin exactly.
- Android viability verified: `acp-jvm` bytecode is major 52 (Java 8, D8-safe) despite the JDK 21 build
  toolchain. Deps are kotlinx (serialization-json, coroutines, io, immutable, atomicfu), kotlin-logging, Ktor.
  kotlinx-io uses `java.nio`, so minSdk 26 is safest (24 probably works, untested).
- Transports: core `acp` is STDIO; `acp-ktor-client` gives client-side WebSocket
  (`HttpClient.acpProtocolOnClientWebSocket(url)`), which on Android uses the OkHttp engine. That solves the
  "ACP has no network transport" problem.
- Do NOT use the Java SDK here: `acp-core` is Java 17 + its `acp-websocket-jetty` / `acp-streamable-http-jetty`
  modules are agent-side servers (Jetty/Reactor). Host/bridge side only.
- Target ACP v1 stable (1.9.x); v2 is unstable/draft.

Known feature loss vs the raw pi-bridge protocol (validate before committing to ACP):

- No session `fork`/`clone`/tree UI - `session/fork` is unstable-only in ACP and unimplemented by `pi-acp`
- pi extension commands are not advertised as ACP slash commands (`pi-acp` hardcodes
  `includeExtensionCommands: false`) - they still run if typed as prompt text
- Extension UI is reduced: only `select`/`confirm` are bridged (to permission prompts); `input`/`editor`
  cancelled, `custom` overlays no-op, widgets/status/theme unsupported
- pi event stream is flattened; `extension_error` is dropped entirely
- `pi-acp` emits `usage_update` with `used`/`size` but drops `cost`, even though ACP supports it and
  `get_session_stats` returns it (upstream issue #106)
- `pi-acp` keeps one live agent subprocess per ACP connection
- Consequence: if pi fidelity matters more than agent breadth, the pi-bridge path wins

References: `agentclientprotocol/kotlin-sdk`, `agentclientprotocol/java-sdk`,
docs at `agentclientprotocol.com/libraries/kotlin`.
