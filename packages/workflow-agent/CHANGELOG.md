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
- Added a general Pi workflow entry with startup diagnostics, Planner task intake and confirmation, active-run recovery, progress reporting, Workspace state synchronization, and Git commit/push acceptance.
- Added `/init` to fork the generic Workspace `main` into a project-local Workspace and initialize project knowledge from user materials and repository facts.
- Added session-persistent project directory selection through `/project-dir [path]` and `/init [path]`.
- Added automatic OCX user configuration under the Pi agent directory and `/ocx-setup` guidance for installation, account setup, proxy startup, and configuration refresh.

### Changed

- Desktop sessions now start with full control: ZCode uses `yolo`, and DeepSeek Harness uses and verifies `danger-full-access`.
- ZCode now prefers exact OCX public selectors and negotiates the reasoning level accepted by each custom-provider model.
- ZCode Executor sessions now default to `high` reasoning and Planner sessions to `medium`, with compatibility fallback when ZCode rejects the default.
- Project configuration, Workspace, runtime records, and Supervisor state now always resolve inside the active project directory; environment overrides can no longer split one project across unrelated paths.
- A configured OCX proxy now starts automatically when `sw-agent` opens and the proxy is not already running.
