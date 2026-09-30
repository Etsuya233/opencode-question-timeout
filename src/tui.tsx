import { createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"

import {
  autoAnswer,
  describeAutoAnswer,
  FORM_MODE,
  INTERACTION_KEYS,
  isQuestionForm,
  readTimeout,
  secondsLeft,
  type Form,
} from "./question.ts"

/**
 * opencode-question-timeout
 *
 * Puts a countdown on OpenCode's `question` tool and answers it for you when
 * the clock runs out.
 *
 * The failure mode this exists for: the model calls `question`, the TUI blocks
 * on a prompt, and a long unattended run sits there until someone notices. With
 * a timeout, the worst case is a wrong-but-cheap answer instead of a stall.
 *
 * How it hooks in
 * ---------------
 * V2 has no `question` primitive — the tool creates a **Form** tagged
 * `metadata.kind === "question"` (see `question.ts` for the full mapping). So
 * this is a terminal plugin: it drives the countdown off the `form.created` /
 * `form.replied` / `form.cancelled` events, replies through
 * `context.data.session.form`, and draws the clock into the
 * `session.composer.top` slot, which the host renders immediately above the
 * question prompt.
 *
 * That slot choice is load-bearing. `session.composer.top` sits outside the
 * host's own `<Switch>` that decides between permission prompt, form prompt and
 * composer, so the clock stays visible in every one of those states, including
 * the narrow-terminal layout. `prompt.footer.status` would not work: the
 * composer is unmounted while a form is pending, so that slot never renders.
 *
 * Why the timeout is safe
 * -----------------------
 * The human and the clock race by design — the whole point is that either may
 * win. The client already treats a lost race as success: `settleForm` in the
 * OpenCode client swallows `FormNotFoundError` and `FormAlreadySettledError`
 * when the id matches the form being settled, so a reply that arrives after the
 * user clicked resolves quietly instead of raising an error toast. This
 * therefore never guards its reply with a lock; adding one would only risk
 * leaving a form pending when the human had in fact already answered it.
 *
 * What this cannot do
 * -------------------
 * Server plugins have no form API at all (`packages/plugin/src/promise/`
 * exposes agent, command, event, integration, mcp, model, permission, provider,
 * reference, session, shell, skill, tool, vcs, websearch and worktree — no
 * form), so there is no headless equivalent. `opencode run` and other
 * non-terminal clients keep the existing blocking behaviour. Fixing that needs
 * a timeout inside the tool itself, not a plugin.
 */

const ID = "opencode-question-timeout"

/** Long enough to read a question, short enough that an unattended run resumes. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Repaint cadence. 1s matches the whole-second display, so a finer tick only burns frames. */
const TICK_MS = 1000

type Config = {
  timeout: number
  notify: boolean
  cancelOnInteraction: boolean
}

const DEFAULTS: Config = {
  timeout: DEFAULT_TIMEOUT_MS,
  notify: true,
  cancelOnInteraction: true,
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function readConfig(options: Record<string, any> | undefined): Config {
  const input = options ?? {}
  return {
    // `timeout: 0` or `false` disables the whole plugin, which is the honest way
    // to express "off" — a negative or unparseable value keeps the default
    // rather than silently disarming the safety net.
    timeout: readTimeout(input.timeout, DEFAULTS.timeout),
    notify: readBoolean(input.notify, DEFAULTS.notify),
    cancelOnInteraction: readBoolean(input.cancelOnInteraction, DEFAULTS.cancelOnInteraction),
  }
}

/** A form as this plugin tracks it: one pending question plus its deadline. */
type Tracked = {
  form: Form
  deadline: number
  /** What the timeout will pick, resolved once so the notice cannot drift. */
  choice: string
  /** The `generation` this entry was opened under. */
  generation: number
}

function Notice(props: { context: Plugin.Context; tracked: Accessor<Tracked | undefined>; now: Accessor<number> }) {
  const context = props.context
  return (
    <Show when={props.tracked()}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={context.theme.text.feedback.warning.base} wrapMode="none">
          {`⏱ ${secondsLeft(props.tracked()!.deadline, props.now())}s`}
        </text>
        <text fg={context.theme.text.muted} wrapMode="none">
          {`后自动选择「${props.tracked()!.choice}」`}
        </text>
      </box>
    </Show>
  )
}

/**
 * Renders the clock and, on mount, adopts a question that was already pending
 * before the plugin loaded.
 *
 * `form.created` only fires for forms that open after the plugin is listening,
 * so a question raised during a TUI reload would otherwise sit untimed. The
 * store still holds it, and this component knows which session it is rendering
 * into, which is what keeps the adoption from claiming another session's form.
 */
function Countdown(props: {
  context: Plugin.Context
  sessionID: string
  tracked: Accessor<Tracked | undefined>
  now: Accessor<number>
  adopt: (form: Form) => void
}) {
  onMount(() => {
    for (const form of props.context.data.session.form.list(props.sessionID) ?? []) {
      props.adopt(form as unknown as Form)
      break
    }
  })
  return <Notice context={props.context} tracked={props.tracked} now={props.now} />
}

/**
 * Stops the clock the moment the user touches the question.
 *
 * The host owns the form's cursor and draft, and neither is readable from a
 * plugin, so the only honest signal that someone has engaged is the keystroke
 * itself. This layer observes the form's own keys and returns `false` from
 * every one of them.
 *
 * Returning `false` is what makes this an observation rather than a key-stealing
 * shortcut. In the opentui keymap a command that returns `false` is marked
 * rejected, the binding loop moves on to the next candidate, and the layer
 * reports nothing handled — so dispatch continues into the host's own
 * lower-priority form layers, which then navigate exactly as before. The key is
 * also never `preventDefault`ed, because that only happens on the success path.
 * The user's arrow key therefore moves the cursor *and* stops the clock, with no
 * chance of swallowing the keystroke.
 *
 * `priority: 100` only decides that this layer is consulted first. It confers
 * no precedence, because rejecting hands the key straight on.
 *
 * This component renders nothing and exists purely to host `keymap.layer`.
 * That call has to happen inside a render, not in `setup`: it is built on
 * `useBindings`, which wraps `createEffect` and `onCleanup` and therefore needs
 * a Solid owner. `setup` runs outside one, where a `createEffect` would never
 * fire and the layer would silently never register. The built-in `btw` plugin
 * registers its keymap layer the same way, from an `app` slot render, which is
 * also what keeps exactly one instance alive regardless of which session is on
 * screen.
 */
function KeymapObserver(props: { context: Plugin.Context; tracked: Accessor<Tracked | undefined>; cancel: () => void }) {
  props.context.keymap.layer(() => ({
    mode: FORM_MODE,
    priority: 100,
    // Reactive: the layer is live only while a question is on the clock.
    enabled: () => props.tracked() !== undefined,
    commands: INTERACTION_KEYS.map((key) => ({
      bind: key,
      run: () => {
        props.cancel()
        return false
      },
    })),
  }))
  return null
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const config = readConfig(context.options as Record<string, any> | undefined)
    if (config.timeout <= 0) return

    const [tracked, setTracked] = createSignal<Tracked>()
    const [now, setNow] = createSignal(Date.now())

    /** The form currently on the clock, or undefined. */
    let current: Tracked | undefined

    /**
     * Monotonic counter identifying "the question the user is looking at now".
     *
     * A reply resolves asynchronously, and by then the world may have moved on:
     * the human may have answered, or a new question may have opened. Comparing
     * generations rather than form ids settles that question — ids can repeat
     * across a TUI reload, a counter cannot go backwards.
     */
    let generation = 0

    /** Stop the clock without invalidating the generation, for our own expiry. */
    const stop = () => {
      current = undefined
      setTracked(undefined)
    }

    /** Stop the clock and invalidate the pending question, for a user action. */
    const clear = () => {
      generation++
      stop()
    }

    /**
     * Settle a question on the human's behalf.
     *
     * `entry.generation` is captured before the request goes out and re-checked
     * after it lands, so a timeout that loses the race stays silent instead of
     * announcing an answer the user made themselves.
     */
    const answer = (entry: Tracked) => {
      const settled = entry.generation
      const reply = autoAnswer(entry.form)
      if (!reply) {
        stop()
        return
      }
      void context.data.session.form
        .reply({ sessionID: entry.form.sessionID, formID: entry.form.id, answer: reply })
        .then(() => {
          if (generation !== settled) return
          if (!config.notify) return
          context.ui.toast.show({
            title: "Question timed out",
            message: `已自动选择「${entry.choice}」`,
            variant: "warning",
          })
        })
        .catch(() => {
          // Already-settled and not-found are swallowed by the client, so
          // reaching here is a genuine failure: the form is still pending on the
          // server and the user can still answer it by hand. The clock has
          // already stopped, so this failure is silent by design — a toast here
          // would compete with the question the user still has to answer.
        })
    }

    // The clock is a single interval for the whole plugin rather than a timer
    // per form. Forms are strictly one-at-a-time per session and a new
    // `form.created` simply restarts it, so a per-form timer would only add
    // handles to clean up.
    const ticker = setInterval(() => {
      const entry = current
      if (!entry) return
      const stamp = Date.now()
      setNow(stamp)
      if (stamp < entry.deadline) return
      // Expiry is our own action, so `stop()` rather than `clear()`: the reply
      // below is still the current generation and is allowed to announce itself.
      stop()
      answer(entry)
    }, TICK_MS)
    onCleanup(() => clearInterval(ticker))

    /**
     * Put a form on the clock, if it is a question we can actually answer.
     *
     * Shared by the event path and the mount-time recovery path, so both apply
     * the same tag filter and the same "nothing to pick" bail-out.
     */
    const adopt = (form: Form) => {
      if (current) return
      if (!isQuestionForm(form)) return
      const choice = describeAutoAnswer(form)
      if (!choice) return
      // A new question supersedes whatever was on the clock, including any
      // reply of ours that is still in flight.
      const entry: Tracked = { form, deadline: Date.now() + config.timeout, choice, generation: ++generation }
      current = entry
      setTracked(entry)
      setNow(Date.now())
    }

    const unsubscribes = [
      // A new question starts the clock. `form.created` is the only event that
      // carries the field list, so a question raised while the plugin was not
      // listening is recovered by `Countdown`'s mount pass instead.
      context.data.on("form.created", (event) => {
        adopt(event.data.form as unknown as Form)
      }),

      // The human answered, or the form was dismissed: stop the clock so a
      // stale deadline cannot reply to a form the user has already settled.
      context.data.on("form.replied", (event) => {
        if (current?.form.id === event.data.id) clear()
      }),
      context.data.on("form.cancelled", (event) => {
        if (current?.form.id === event.data.id) clear()
      }),
    ]

    const offSlot = context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Countdown
          context={context}
          sessionID={input.sessionID}
          tracked={tracked}
          now={now}
          adopt={adopt}
        />
      ),
    })

    /**
     * The keymap observer lives in an `app` slot render so it has a Solid owner
     * to register under and stays mounted across session switches. See
     * `KeymapObserver` for why it cannot be registered from `setup`.
     */
    const offKeymapSlot = config.cancelOnInteraction
      ? context.ui.slot({
          append: "app",
          render: () => <KeymapObserver context={context} tracked={tracked} cancel={clear} />,
        })
      : undefined

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
      offKeymapSlot?.()
      offSlot()
      clearInterval(ticker)
    }
  },
})
