# opencode-question-timeout

An OpenCode V2 terminal plugin that puts a **countdown on the `question` prompt** and
auto-answers with the **first option** when the clock runs out.

It exists for one failure mode: the model calls `question`, the TUI blocks on a prompt,
and a long unattended run sits there until a human happens to look. With a timeout, the
worst case becomes a cheap wrong answer instead of a stall.

```
⏱ 84s  后自动选择「Use Bun」
```

## Install

```sh
npm install @etsuya/opencode-question-timeout
```

Add it to `cli.json` (a terminal-only package belongs here, so it stays active against
remote servers):

```json
{
  "plugins": ["@etsuya/opencode-question-timeout"]
}
```

Restart the TUI, or run `opencode service restart` if the plugin does not appear.

## Options

Configure through the object form in `cli.json`:

```json
{
  "plugins": [
    {
      "package": "@etsuya/opencode-question-timeout",
      "options": {
        "timeout": 180000,
        "notify": true,
        "cancelOnInteraction": true
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timeout` | `number` \| `false` | `120000` | Milliseconds before the question is auto-answered. `0` or `false` disables the plugin entirely. |
| `notify` | `boolean` | `true` | Show a toast when a timeout fires. |
| `cancelOnInteraction` | `boolean` | `true` | Stop the clock as soon as you touch the question. |

A malformed `timeout` (a typo, a negative number) falls back to the default rather than
silently disarming the safety net.

## Any interaction stops the clock

With `cancelOnInteraction` on, moving the cursor is enough to end the countdown. The
moment you press `↑`/`↓`/`j`/`k`, a number key, `←`/`→`/`h`/`l`, `Tab`, `Enter` or
`Space`, the clock is cancelled and the question stays yours for as long as you want
it.

The clock only ever fires on a question nobody has touched. That is the useful
property in practice: the timeout exists to rescue an *unattended* run, and a run where
a human is present and reading options should never have their choice overwritten by
a timer.

This works by observing the keystroke, because the host's form cursor and draft are not
readable from a plugin. The plugin registers a keymap layer scoped to the `form` input
mode, binds the same keys the host's form prompt uses, and returns `false` from each
one.

That return value is what makes it an observation rather than a shortcut that steals
keys. In the opentui keymap a command returning `false` is marked rejected, the binding
loop continues to the next candidate, and the layer reports nothing handled — so
dispatch proceeds into the host's own lower-priority form layers and the key does
exactly what it always did. The key is also never `preventDefault`ed, since that only
happens on the success path. The host's layers are themselves conditional (the
`h`/`j`/`l` bindings switch off while you type a custom answer) and this design needs
no mirroring: when nothing ends up handling the key it stays un-consumed and still
reaches the textarea.

`escape` is deliberately not bound. It dismisses the form, which already emits the
event that stops the clock.

## How it works

V2 has no `question` primitive. The `question` tool is a thin producer of a **Form**,
tagged `metadata.kind === "question"`:

```ts
// packages/core/src/tool/plugin/question.ts
forms.ask({
  metadata: { kind: "question", tool: { messageID, id } },
  fields: [toField(input.questions[0], 0), ...],
})
```

Each question becomes one field keyed `q0`, `q1`, … — a `string` field carrying
`options` for a single choice, or `multiselect` when the model passed
`multiple: true`. Forms are the same mechanism OAuth login and MCP elicitation use,
which is why this plugin filters on the `kind` tag and never guesses at a form it did
not recognise.

The plugin then:

1. starts a deadline on `form.created`, for questions raised by a session this window owns,
2. draws the clock into the `session.composer.top` slot, for the question actually on screen,
3. cancels on `form.replied` / `form.cancelled`,
4. on expiry, replies with the first option of every answerable field.

Steps 1 and 2 are scoped differently on purpose. A background tab's question is timed
but not drawn, and a question in a session this window does not own is neither — see
[Multiple TUI windows](#multiple-tui-windows).

### Why the clock renders where it does

`session.composer.top` sits **outside** the host's `<Switch>` that chooses between
permission prompt, form prompt and composer, so the countdown stays visible in all
three states, including the narrow-terminal layout.

`prompt.footer.status` would not work: the composer is unmounted while a form is
pending, so that slot never renders at all.

### Why the timeout is safe

The human and the clock race by design — either may win, and that is the point. The
client already treats a lost race as success: `settleForm` swallows `FormNotFoundError`
and `FormAlreadySettledError` when the id matches the form being settled, so a reply
arriving after the user clicked resolves quietly instead of raising an error toast.

The plugin therefore never guards its reply with a lock. Adding one would only risk
leaving a form pending when the human had in fact already answered it.

### Which fields it answers

Answered with the first option: `string` and `multiselect` fields with options,
`boolean` fields (falling back to their declared `default`), and multiselect fields
with a non-empty `default`.

Deliberately skipped:

- **`external`** — points at a URL a human must visit; only `true` acknowledges it.
- **`hidden`** — the interactive prompt skips these too.
- **conditional (`when`)** — a condition can only be evaluated against answers that do
  not exist yet, and the server rejects answers for fields it considers inactive.
  Filling one speculatively is likelier to fail the whole reply than to help it. The
  `question` tool never emits `when`, so this costs nothing in practice.

If a form has nothing answerable, no request is sent at all.

## Limitations

- **Terminal only.** Server plugins have no form API — the promise context exposes
  agent, command, event, integration, mcp, model, permission, provider, reference,
  session, shell, skill, tool, vcs, websearch and worktree, but no form. A server
  plugin can observe `form.created` yet has no way to reply to it. So `opencode run`
  and other non-terminal clients keep the existing blocking behaviour. Fixing that
  requires a timeout inside the tool itself, not a plugin.
- **The clock lives in the TUI process.** Closing the terminal leaves the server-side
  form pending until it is garbage collected.
- **Only the sessions a window owns get a clock.** The server's event feed is global,
  so a `form.created` reaches every TUI on the server. This plugin admits a question
  only when the session is on screen in this window or open in one of its background
  tabs; a question belonging to a session this window knows nothing about is left to
  whichever window is showing it. See below.

## Multiple TUI windows

The countdown is scoped to the window raising it. Two windows open on different
sessions each time only their own questions, and a countdown never appears above an
unrelated prompt.

The scoping exists because of a specific hazard rather than tidiness. `form.created`
is broadcast server-wide, so a plugin that reacted to every event would have each
window counting down — and settling — the other windows' questions. Cancelling a
clock is driven by a keystroke, and a keystroke is process-local: the window you are
not looking at cannot hear you press `↓`, so it would count down and answer a question
you were in the middle of reading. A stall is recoverable; a silent wrong answer is
not.

Two cases are deliberately still covered:

- **A subagent's question** is timed from its root session's view, which is where the
  host draws the prompt for it.
- **A background tab's question** is timed even though no prompt is rendered for it.
  That session is blocked and you are demonstrably not reading it, so it is exactly
  the unattended run the timeout exists for. The clock runs silently; the moment you
  switch to that tab the countdown appears, and your first keystroke cancels it.

If the same session is open in two windows at once, both will count it down. The
first reply wins and the already-settled handling keeps that correct, but both
windows may show a toast.

## Development

```sh
npm install
npm run typecheck
npm test
```

The decision logic lives in `src/question.ts` with no Solid, OpenTUI or plugin imports,
so it is unit tested with `node --test` alone; `src/tui.tsx` only wires it to reactive
signals and the OpenCode client.

## License

MIT
