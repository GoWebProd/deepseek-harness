# Agent Note: External Session display history

Status: implemented

English | [中文](2026-11-09-external-session-display-history.zh.md)

## Problem

An external agent engine can own execution and conversation history while Harness supplies its Chat interface. Copying that history into a native Session creates another persistent transcript. Native history cursors, model requests, and reconstruction guarantees then appear to describe data the Harness engine never executed.

Older-page insertion also conflicts with the native append-only log. Expanding history by replacing Sessions changes local identity and cannot safely bypass active work, parked input, or uncertain acknowledgements.

## Decision

The Session Controller exposes an effect-owned external history registry. A provider passively resolves a Harness Session address and supplies display pages, observation, and separate cold Agent activation. The generated `sessionHistory` Remote service authorizes the addressed Session before provider resolution. It carries opaque source cursors and a generation independently of native control and metadata projection cursors.

The Client selects one history driver and publishes its ordered window through the existing Conversation assembly. External records are display facts, not a native Session journal or evidence of model execution. Source-owned Definitions render them. Append and patch frames retain already loaded older history; replacement explicitly resets the window. Authoritative input receipts retire local echoes without matching message text or creating history.

The ordinary Agent resolver tries external activation before native persistence. Concurrent callers share provider-owned activation; cancelling one caller only abandons its wait. Native journal operations reject claimed external identities. A provider error never delegates to native history. Provider removal cancels and drains reads, activation, and upstream iterators, without stopping its engine. A known claim remains unavailable during the Host lifetime; the provider restores ownership from its own durable metadata after restart.

The [native plugin-record decision](2026-08-30-retain-ignorable-external-session-events.md) still owns native append and reload. The [Client reference decision](2026-09-15-client-session-references.md) still owns retention; neither decision is superseded by this independent display source.

## Alternatives considered

**Persist projected copies as native messages.** Rejected because the external engine remains authoritative and the duplicate transcript suggests native reconstruction guarantees that do not exist.

**Build another native Session whenever an older page loads.** Rejected because local identity, pending work, and reader anchors then require replacement even for read-only pagination, while the transcript is still copied persistently.

**Mutate the Client's event source behind its controller.** Rejected because pagination state, journal cuts, reconnect policy, and the Conversation window would have different owners. A registered driver keeps them under one lifecycle.

## Consequences

Native Sessions retain their existing journal and SDK operations. Custom Client carriers need the new discovery namespace, and non-owner policies must grant its actions explicitly. No native Session format changes. An external adapter remains responsible for its own engine persistence and reset detection; this registry does not create a reliable external revision when the backend supplies none.

Host tests cover passive discovery, opaque paging, access before provider lookup, activation without native reads, independent caller cancellation, provider removal, ambiguity, native delegation, and rejection of native position operations. A real Loader profile composes the production Gateway and external-history service with a fake backend provider; its package-local display snapshot records pages and patches without mounting Session persistence or inference. Client tests cover driver selection, paging, patch/reset consistency, receipts, and disconnection. Exact trajectory reconstruction and recursive external subagent ownership are not supplied by this mechanism.
