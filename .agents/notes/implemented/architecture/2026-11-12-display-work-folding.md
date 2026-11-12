# Agent Note: Display-only work folding

Status: implemented

English | [中文](2026-11-12-display-work-folding.zh.md)

## Problem

Plugin-owned messages can render at Session locations without native Engine Turns. Native Turn folding cannot collapse their intermediate replies, reasoning and tools without inventing execution records.

## Decision

Chat Definitions opt in with `displayWork` source markers and a backend tail status. The Chat Builder groups loaded nodes at user-message boundaries and publishes shared display summaries. Their controls use the existing collapse-timing, reply-retention and verbose-mode preferences; their identities remain separate from Engine Turns.

The latest exchange stays open when its state is unknown, running or interrupted. A newly loaded real input replaces a partial-prefix grouping without changing the source node keys. Manual choices follow the final-answer identity. Streaming text reuses a summary when its grouping facts are unchanged.

## Alternatives considered

Synthetic Turn and Step events would imply model execution evidence that the source does not supply. Adapter-owned copies of Chat controls would duplicate presentation policy. Keeping the summaries in Chat shares the existing preference and disclosure owners.

## Consequences

Sources without the optional marker keep their existing rendering. Display grouping adds no Session records, context changes, duration or model-step counts. Its state and node membership describe only the loaded window, so a source remains responsible for its canonical history and run-state accuracy.
