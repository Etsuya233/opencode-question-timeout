/**
 * Server entrypoint.
 *
 * This is a terminal-only plugin, and that is a hard architectural limit rather
 * than a packaging choice. The countdown has to be able to *answer* a pending
 * question, and the server plugin context exposes no form API — its domains are
 * agent, command, event, integration, mcp, model, permission, provider,
 * reference, session, shell, skill, tool, vcs, websearch and worktree. A server
 * plugin can observe `form.created` but has no way to reply to it.
 *
 * This file exists only so the package is well-formed if it is ever listed in
 * `opencode.json` rather than `cli.json`; the CLI resolves `./tui` from the same
 * directory and that is the entry that does the work.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-question-timeout.server",
  setup() {},
})
