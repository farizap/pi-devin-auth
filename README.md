# pi-devin-auth

A [pi](https://pi.dev) coding agent extension that adds the **Devin** (Cognition / Windsurf) provider with browser-based OAuth login and native streaming.

## Install

### Via pi (recommended)

```bash
pi install npm:pi-devin-auth
```

Then enable the extension:

```bash
pi config
```

### Manual / local dev

```bash
pi -e ./extensions/index.ts
```

Or copy `extensions/index.ts` into `~/.pi/agent/extensions/` for auto-discovery.

## Usage

### Login

```bash
/login devin
```

This opens `https://windsurf.com/windsurf/signin` in your browser. After signing in, the page displays an auth token — paste it into the pi prompt. The extension exchanges it for a long-lived Devin API key via `register.windsurf.com`.

### Select a model

```bash
/model devin/swe-1-6
```

### Logout

```bash
/logout devin
```

## Local wire diagnostics

Load the local extension and compare a successful SWE request with a Claude request:

```bash
cd /path/to/pi-devin-auth

PI_DEVIN_DEBUG=1 \
PI_DEVIN_DEBUG_FILE=/tmp/pi-devin-swe.jsonl \
pi -e ./extensions/index.ts --no-extensions \
  --provider devin --model swe-1-7 --tools read \
  --no-session -p 'Read README.md and report its title.'

PI_DEVIN_DEBUG=1 \
PI_DEVIN_DEBUG_FILE=/tmp/pi-devin-claude.jsonl \
pi -e ./extensions/index.ts --no-extensions \
  --provider devin --model claude-sonnet-5-medium --tools read \
  --no-session -p 'Read README.md and report its title.'
```

Diagnostics are JSONL. Default logging excludes API keys, JWTs, prompt text, tool descriptions, and schemas. Set `PI_DEVIN_DEBUG_WIRE=1` only when raw tool-definition protobuf is needed; that value includes tool descriptions and schemas. Debug files are created with mode `0600`.

## How it works

```bash
pi  --login-->  windsurf.com (Auth0)  --token-->  register.windsurf.com (RegisterUser)  --api_key-->  ~/.pi/agent/auth.json
pi  --chat-->   streamDevin()  -->  cloud-direct/streamChatEvents()  -->  server.codeium.com (GetChatMessage gRPC)  -->  pi events
```

The extension reuses the battle-tested cloud-direct gRPC layer from [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) and wraps it in pi's native `streamSimple` + `oauth` extension API.

### Claude tool compatibility

Cognition's direct `GetChatMessage` adapter rejects native protobuf tool definitions for Claude models. For a Claude request with active pi tools, the extension uses a text compatibility protocol instead:

```text
pi active tools -> tool names, descriptions, JSON Schemas in Claude prompt
Claude JSON tool-call envelope -> normal pi toolCall event -> pi executes tool
pi tool result -> text history on Claude continuation turn
```

This preserves pi's normal tool executor, permissions, and automatic tool discovery. New active pi tools work without per-tool changes in this extension.

Limits:

- Claude tool calls are prompt-constrained JSON, not provider-native function calls.
- Large tool catalogs increase prompt size.
- The shim rejects unknown tool names and malformed tool envelopes as normal text responses.
- SWE and GPT continue using native cloud-direct tool protobufs. Claude without tools also uses the normal cloud-direct text path.

`src/desktop/` remains an experimental native Cascade transport. It is not selected automatically.

## Models

Models are fetched dynamically from Cognition's `GetCascadeModelConfigs` RPC after login, so the list always reflects what your account tier can access. A static fallback set is included for offline use.

## Attribution

Fork of [nmzpy/pi-devin-auth](https://github.com/nmzpy/pi-devin-auth),
originally derived from
[opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth).

This fork adds Claude tool compatibility through a prompt-based JSON tool
protocol. See commit history for changes.  

## License

MIT
