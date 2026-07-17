# AGENTS.md — pi-devin-auth

## Overview

A [pi](https://pi.dev) coding agent extension that registers the `devin` provider (Cognition / Windsurf) with OAuth login and native streaming. Reuses the cloud-direct gRPC layer from `opencode-windsurf-auth`.

## Architecture

```text
extensions/index.ts          # pi extension entry — registerProvider("devin", { oauth, streamSimple, models })
src/oauth/
  login.ts                   # ADAPTED — pi OAuthLoginCallbacks (manual-paste flow)
  register-user.ts           # COPIED verbatim — RegisterUser RPC at register.windsurf.com
  types.ts                   # COPIED verbatim — WindsurfRegion, DEFAULT_REGION
src/cloud-direct/            # COPIED verbatim — gRPC to server.codeium.com
  auth.ts                    #   GetUserJwt (short-lived JWT mint + in-memory cache)
  chat.ts                    #   GetChatMessage streaming (Connect-RPC + manual protobuf)
  catalog.ts                 #   GetCascadeModelConfigs (per-account model catalog)
  metadata.ts                #   Metadata proto builder
  wire.ts                    #   Protobuf + Connect-streaming envelope helpers
  index.ts                   #   Public re-exports
src/context-map.ts           # NEW — pi Message[]/Tool[] -> ChatHistoryItem[]/ToolDef[]
src/stream.ts                # NEW — streamDevin: selects cloud-direct or Claude tool shim
src/claude-tool-shim.ts      # NEW — text tool protocol -> normal pi toolCall events
src/desktop/                 # EXPERIMENTAL — native Cascade transport, not auto-selected
  language-server.ts         #   isolated Devin LS child lifecycle + authenticated local RPC
  cascade.ts                 #   StartCascade/SendUserCascadeMessage/trajectory RPC encoding
  chat.ts                    #   Cascade trajectory polling/events
src/models.ts                # NEW — dynamic catalog -> ProviderModelConfig[] + fallback
```

## Build & Test

```bash
npm install          # install deps
npx tsc --noEmit     # typecheck
npm test             # run unit tests (bun test or node --test)
```

pi loads extensions via jiti (no build step needed for runtime use).

## Key Design Decisions

1. **Native streamSimple** (Option B): No background proxy. `streamDevin()` emits pi's `AssistantMessageEventStream` events. SWE/GPT use cloud-native tools. Claude with active pi tools uses `claude-tool-shim.ts`: catalog and JSON Schema enter prompt text, JSON tool envelopes become normal pi toolCall events, and pi executes tools normally. Tool discovery is automatic from `Context.tools`.
2. **Manual-paste OAuth**: pi's `OAuthLoginCallbacks` doesn't support loopback servers. We use `redirect_uri=show-auth-token` so the Windsurf SPA renders the token for the user to paste via `callbacks.onPrompt()`.
3. **Non-expiring token shape**: Windsurf's `RegisterUser` returns a long-lived `api_key` with no refresh token. We set `OAuthCredentials = { refresh: "", access: apiKey, expires: now + 365 days }`. `refreshToken()` is a no-op.
4. **Dynamic model catalog**: Fetched from `GetCascadeModelConfigs` via `oauth.modifyModels()` after login. Static fallback for offline.
5. **In-memory JWT cache only**: No disk persistence for the short-lived `user_jwt`. Re-mint cost (~200ms) is negligible.

## Token Shapes

- **firebaseIdToken**: Short-lived JWT from Auth0 browser sign-in. Exchanged via RegisterUser, then discarded.
- **api_key**: Long-lived credential from RegisterUser. Format: `devin-session-token$<JWT>`. Used as `Metadata.api_key` in every gRPC call. Stored by pi in `~/.pi/agent/auth.json`.
- **user_jwt**: Short-lived (~24 min) JWT minted from `GetUserJwt`. Cached in-memory per (apiKey, host). Required alongside api_key for chat RPCs.

## Cloud-Direct gRPC

Cloud-direct RPCs hit `https://server.codeium.com` over HTTPS with Connect-RPC framing:

- `GetUserJwt` — unary, `application/proto`
- `GetCascadeModelConfigs` — unary, `application/proto`
- `GetChatMessage` — streaming, `application/connect+proto` (gzip-compressed frames)

Manual protobuf encoding (no protobuf library). Field numbers hardcoded from mitm captures of Windsurf's language_server traffic.

## Related

- [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) — the opencode plugin this is derived from
- [pi custom-provider docs](https://pi.dev/docs/latest/custom-provider)
