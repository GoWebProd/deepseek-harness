# Agent Note: Lazy tool display material

Status: implemented

English | [中文](2026-11-10-lazy-tool-display-material.zh.md)

## Problem

External history can provide bounded argument/result previews. An additional detail node duplicates the call in the transcript, while loading every full result defeats paging.

## Decision

The optional Session standard prop `createToolMaterial` prepares an inert, read-only material handle per view. Chat's disclosure binding owns committed activation, snapshot subscriptions, expansion observation, and disposal. Tool views only call those framework-produced Hooks and render the published block through the existing keyed toolview. The provider owns fetching, validation, cancellation, and cached material.

Preparation acquires no resources, because React may abandon a render. A handle supports activation after Strict Mode cleanup, keeps snapshots stable until changed, and cancels unfinished reads when collapsed or disposed. Snapshot readers share activation until the final reader leaves.

## Alternatives considered

Separate detail nodes duplicate the visible call. Provider-owned copies of native cards drift from their toolviews. Node-valued render callbacks hide a composition path; a data-only handle keeps rendering in the existing slot. Business-owned subscriptions or manufactured disclosure Hooks would duplicate framework ownership.

## Consequences

Unrelated calls retain their existing disclosure Hook. Entering or leaving source-backed rendering remounts the atomic card to separate Hook lifetimes. Loading and retry stay within one call entry. The contract adds no Session records, model inputs, tool executions or backend API.
