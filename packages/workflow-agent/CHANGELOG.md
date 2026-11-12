# Changelog

## [Unreleased]

### Added

- Added governed desktop workflow configuration and OpenCodex route resolution without silent fallback.
- Added confirmation-gated dispatch, stable acceptance items, Executor authorization, review return, pause, takeover, cancellation, restart reconciliation, and single-writer runtime persistence.
- Added the ZCode app-server bridge, visible Chrome provider, model binding for OpenCode(Chat) and CommandCode(Chat), and Workspace Supervisor integration.
- Added the authenticated DeepSeek Desktop Host bridge, session-local model readback, Chrome DevTools MCP evidence checks, and the P3 Pi command.
- Added a mandatory OCX runtime readiness gate, config-driven ZCode provider switching, and native-only DeepSeek Harness model validation.
- Added Windows path discovery for Chrome, ZCode, and DeepSeek Harness.
- Added persistent Executor-to-Planner review loops with per-criterion evidence, repair redispatch, and stale writer-lock recovery.
- Added repeatable 60-attempt checkpoints with Planner failure reports, user-selected continuation counts, and persisted cancellation.
