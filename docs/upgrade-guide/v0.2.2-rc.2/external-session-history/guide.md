---
kind: upgrade-guide
description: "Custom Client Session transports now require the sessionHistory discovery namespace before opening history."
---
# Client Session history discovery

English | [中文](guide.zh.md)

## Change

Client Sessions discover their history source through `sessionHistory.info` before opening it. Custom Remote carriers, test doubles, and non-owner access policies that provide only the previous `session` namespace need updating. The API remains pre-stable; Host and Client artifacts must come from the same build. Ordinary native `session.events`, `follow`, projection, and SDK messages retain their existing formats. No Session data migration is required.

## Migration

1. Rebuild and deploy the Host and Client together with `pnpm run build:artifacts`. This regenerates Typert Host definitions and Client Remote types, including `ClientRemote['sessionHistory']`; do not hand-edit generated declarations. Deploy the rebuilt `@deepseek-ai/dsh-api-remotes` package too: its Client bundle embeds the selected generated Remote contributions. Updating only Session Controller leaves an older assembly without `remote.sessionHistory`, so the Session Client cannot start.
2. Supply `sessionHistory.info/page/observe` in custom Client carriers. A native source returns `{ kind: 'native' }`. Use the generated types rather than a second handwritten wire interface.
3. Explicitly grant `sessionHistory/info` on already readable Session resources when a non-owner Client needs discovery. External page and observation access require their own policy decision; a native history grant does not imply them.
4. External engine plugins register through `sessionController.registerExternalHistoryProvider`. Treat presentation positions as display-only: native fork, exact replay, and `loadThrough` cannot use them. Confirm native chats retain their existing behavior and external chats page without writing transcript copies to SessionPersistence.

The mandatory integration packages are `@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-client-ui-chat`, `@deepseek-ai/dsh-client-ui-conversation`, and `@deepseek-ai/dsh-client-ui-trajectory`. They include the generated Remote assembly and its display consumers; these five alone do not establish compatibility with a base built from another revision.

Deploy a coherent runtime dependency closure and baseline Web frontend from the same checkout and build, including the UI renderer and statically bundled `ui-slots` code. Identical pre-stable package version strings do not guarantee ABI compatibility between revisions. A partial update over a different base can register every service and deliver history successfully while the renderer drops the conversation body. Use a full runtime update when the base revision differs or cannot be verified.
