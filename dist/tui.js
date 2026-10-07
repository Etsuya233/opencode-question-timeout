import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Plugin } from "@opencode/plugin/tui";
import { autoAnswer, describeAutoAnswer, FORM_MODE, INTERACTION_KEYS, isQuestionForm, readTimeout, secondsLeft } from "./question.js";

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
 * Why it only times the questions it owns
 * ---------------------------------------
 * The server's event feed is global. `form.created` reaches every TUI connected
 * to the server, whatever session raised it, so a plugin that adopts whatever
 * arrives would have each window timing — and answering — the other windows'
 * questions. That second half is the dangerous one: the keystroke that cancels
 * the clock is process-local, so a window the user is not looking at would count
 * down and settle a question they are in the middle of reading.
 *
 * So a form is admitted only when this TUI owns its session — the one on screen
 * or one open in a background tab here (see `ownedSessions`). A question
 * belonging to a session this window knows nothing about is left to whichever
 * window is showing it.
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

const ID = "opencode-question-timeout";

/** Long enough to read a question, short enough that an unattended run resumes. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Repaint cadence. 1s matches the whole-second display, so a finer tick only burns frames. */
const TICK_MS = 1000;
const DEFAULTS = {
  timeout: DEFAULT_TIMEOUT_MS,
  notify: true,
  cancelOnInteraction: true
};
function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function readConfig(options) {
  const input = options ?? {};
  return {
    // `timeout: 0` or `false` disables the whole plugin, which is the honest way
    // to express "off" — a negative or unparseable value keeps the default
    // rather than silently disarming the safety net.
    timeout: readTimeout(input.timeout, DEFAULTS.timeout),
    notify: readBoolean(input.notify, DEFAULTS.notify),
    cancelOnInteraction: readBoolean(input.cancelOnInteraction, DEFAULTS.cancelOnInteraction)
  };
}

/** A form as this plugin tracks it: one pending question plus its deadline. */

/** Tracked entries by the session that owns the form. */

/**
 * The sessions whose forms the host is willing to prompt for, in the order it
 * walks them.
 *
 * This mirrors the `forms` memo in `packages/tui/src/routes/session/index.tsx`
 * exactly, and it has to: the server's event feed is global, so every TUI
 * connected to the same server sees every `form.created` no matter which session
 * raised it. Without an explicit owner set, each instance would start a clock —
 * and answer — questions raised in sessions it is not showing.
 *
 * Two cases carry over from the host and are deliberate:
 *
 * - A subagent's own view shows nothing but global elicitations, so it gets an
 *   empty set. Its questions are prompted from the root session's view, and that
 *   is where they get timed.
 * - The `global` bucket is MCP elicitation, which never carries the question tag,
 *   so it is left out. Including it would change nothing and cost a lookup.
 */
function promptedSessions(context, sessionID) {
  if (context.data.session.get(sessionID)?.parentID) return [];
  const family = context.data.session.family(sessionID);
  return [sessionID, ...family.filter(id => id !== sessionID)];
}

/**
 * The sessions whose questions this TUI takes responsibility for.
 *
 * Wider than the one on screen on purpose. A session open in a background tab
 * has no prompt rendered for it, so nothing in this process would otherwise ever
 * rescue it — yet it is exactly the unattended run the timeout exists for, and
 * the user is demonstrably not reading it. Owning it here is also safe: the
 * moment the user switches to that tab the form prompt appears, the keymap layer
 * below goes live, and their first keystroke cancels the clock.
 *
 * Sessions belonging to no tab here and not on screen are left alone. Another
 * window is showing them, and answering over someone who is mid-read is the one
 * outcome worse than a stall.
 */
function ownedSessions(context) {
  const route = context.ui.router.current();
  const owned = new Set();
  if (route.type === "session") for (const id of promptedSessions(context, route.sessionID)) owned.add(id);
  for (const tab of context.ui.tabs.list()) for (const id of promptedSessions(context, tab.sessionID)) owned.add(id);
  return owned;
}

/**
 * The question on screen, or undefined when nothing is being timed.
 *
 * The host prompts one form at a time and takes the first of that list, so the
 * clock has to name the same one — a countdown for a question the user cannot
 * see is worse than no countdown. This is deliberately narrower than
 * `ownedSessions`: a background tab's clock runs, but its notice does not
 * appear until the user actually goes there.
 */
function displayed(context, tracked, sessionID) {
  if (sessionID === undefined) return undefined;
  for (const id of promptedSessions(context, sessionID)) {
    const entry = tracked[id];
    if (entry?.armed) return entry;
  }
  return undefined;
}
function Notice(props) {
  const context = props.context;
  return _$createComponent(Show, {
    get when() {
      return props.entry();
    },
    children: entry => (() => {
      var _el$ = _$createElement("box"),
        _el$2 = _$createElement("text"),
        _el$3 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$3);
      _$setProp(_el$, "flexDirection", "row");
      _$setProp(_el$, "gap", 1);
      _$setProp(_el$, "flexShrink", 0);
      _$setProp(_el$2, "wrapMode", "none");
      _$insert(_el$2, () => `⏱ ${secondsLeft(entry().deadline, props.now())}s`);
      _$setProp(_el$3, "wrapMode", "none");
      _$insert(_el$3, () => `后自动选择「${entry().choice}」`);
      _$effect(_p$ => {
        var _v$ = context.theme.text.feedback.warning.base,
          _v$2 = context.theme.text.muted;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$;
    })()
  });
}

/**
 * Renders the clock and, on mount, adopts questions that were already pending
 * before the plugin loaded.
 *
 * `form.created` only fires for forms that open after the plugin is listening,
 * so a question raised during a TUI reload would otherwise sit untimed. The
 * store still holds it, so the mount pass picks it up. The scan covers every
 * session this TUI owns rather than the one being rendered, which is what
 * recovers a subagent's question and a background tab's.
 *
 * The notice itself stays scoped to the rendered session, so a recovery for a
 * background tab starts a clock without drawing anything above the wrong prompt.
 */
function Countdown(props) {
  const entry = createMemo(() => displayed(props.context, props.tracked, props.sessionID));
  onMount(() => {
    // Every session this TUI owns, not just the one being rendered: a question
    // already pending in a background tab has no prompt to re-trigger
    // `form.created`, so this pass is the only thing that will time it.
    for (const id of ownedSessions(props.context)) {
      for (const form of props.context.data.session.form.list(id) ?? []) {
        props.adopt(form);
      }
    }
  });
  return _$createComponent(Notice, {
    get context() {
      return props.context;
    },
    entry: entry,
    get now() {
      return props.now;
    }
  });
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
function KeymapObserver(props) {
  const entry = createMemo(() => {
    const route = props.context.ui.router.current();
    return displayed(props.context, props.tracked, route.type === "session" ? route.sessionID : undefined);
  });
  props.context.keymap.layer(() => ({
    mode: FORM_MODE,
    priority: 100,
    // Reactive: the layer is live only while a question this TUI is showing is
    // on the clock. A question in another session must not be cancellable from
    // here — the keystroke would belong to a prompt that is not on screen.
    enabled: () => entry() !== undefined,
    commands: INTERACTION_KEYS.map(key => ({
      bind: key,
      run: () => {
        const current = entry();
        if (current === undefined) return false;
        props.cancel(current);
        return false;
      }
    }))
  }));
  return null;
}
export default Plugin.define({
  id: ID,
  setup(context) {
    const config = readConfig(context.options);
    if (config.timeout <= 0) return;
    const [tracked, setTracked] = createStore({});
    const [now, setNow] = createSignal(Date.now());

    /**
     * Monotonic counter identifying "the question the user is looking at now".
     *
     * A reply resolves asynchronously, and by then the world may have moved on:
     * the human may have answered, or a new question may have opened. Comparing
     * generations rather than form ids settles that question — ids can repeat
     * across a TUI reload, a counter cannot go backwards.
     */
    let generation = 0;

    /** Whether the record still holds the very entry a reply was sent for. */
    const stillOurs = entry => tracked[entry.form.sessionID]?.generation === entry.generation;

    /** Drop an entry, but only while it is still the one we mean to drop. */
    const release = entry => {
      if (!stillOurs(entry)) return;
      setTracked(produce(draft => {
        delete draft[entry.form.sessionID];
      }));
    };

    /**
     * Settle a question on the human's behalf.
     *
     * The entry is re-checked by generation once the request lands, so a timeout
     * that lost the race stays silent instead of announcing an answer the user
     * made themselves. Either way the entry is released: the clock is spent
     * whether the reply won or lost.
     */
    const answer = entry => {
      const reply = autoAnswer(entry.form);
      if (!reply) {
        release(entry);
        return;
      }
      void context.data.session.form.reply({
        sessionID: entry.form.sessionID,
        formID: entry.form.id,
        answer: reply
      }).then(() => {
        const won = stillOurs(entry);
        release(entry);
        if (!won) return;
        if (!config.notify) return;
        context.ui.toast.show({
          sessionID: entry.form.sessionID,
          title: "Question timed out",
          message: `已自动选择「${entry.choice}」`,
          variant: "warning"
        });
      }).catch(() => {
        release(entry);
        // Already-settled and not-found are swallowed by the client, so
        // reaching here is a genuine failure: the form is still pending on the
        // server and the user can still answer it by hand. The clock has
        // already stopped, so this failure is silent by design — a toast here
        // would compete with the question the user still has to answer.
      });
    };

    // One interval drives every tracked question rather than a timer per entry.
    // A new `form.created` inserts into the record instead of restarting
    // anything, so there is nothing per-form to schedule here.
    const ticker = setInterval(() => {
      const stamp = Date.now();
      let counting = false;
      for (const sessionID of Object.keys(tracked)) {
        const entry = tracked[sessionID];
        if (!entry?.armed) continue;
        if (stamp < entry.deadline) {
          counting = true;
          continue;
        }
        // Disarm rather than release: the entry has to stay in the record so
        // `answer` can recognise it when the reply lands.
        setTracked(sessionID, "armed", false);
        answer(entry);
      }
      if (counting) setNow(stamp);
    }, TICK_MS);
    onCleanup(() => clearInterval(ticker));

    /**
     * Put a form on the clock, if it is a question we can actually answer and
     * this TUI owns the session that raised it.
     *
     * Shared by the event path and the mount-time recovery path, so both apply
     * the same ownership check, tag filter and "nothing to pick" bail-out.
     */
    const adopt = form => {
      if (!ownedSessions(context).has(form.sessionID)) return;
      if (!isQuestionForm(form)) return;
      const choice = describeAutoAnswer(form);
      if (!choice) return;
      // Re-seeing a form that is already on the clock keeps its original
      // deadline. This is what a session switch or a plugin reload looks like:
      // without this the countdown would silently restart at the full timeout
      // every time the user navigated back to a pending question.
      if (tracked[form.sessionID]?.form.id === form.id) return;
      // A new question supersedes whatever was on the clock for that session,
      // including a reply of ours that is still in flight.
      const entry = {
        form,
        deadline: Date.now() + config.timeout,
        choice,
        generation: ++generation,
        armed: true
      };
      setTracked(form.sessionID, entry);
      setNow(Date.now());
    };

    /** Forget a form the user settled, wherever in the record it sits. */
    const forget = formID => {
      for (const sessionID of Object.keys(tracked)) {
        if (tracked[sessionID]?.form.id !== formID) continue;
        setTracked(produce(draft => {
          delete draft[sessionID];
        }));
      }
    };
    const unsubscribes = [
    // A new question starts the clock. `form.created` is the only event that
    // carries the field list, so a question raised while the plugin was not
    // listening is recovered by `Countdown`'s mount pass instead.
    context.data.on("form.created", event => {
      adopt(event.data.form);
    }),
    // The human answered, or the form was dismissed: stop the clock so a
    // stale deadline cannot reply to a form the user has already settled.
    context.data.on("form.replied", event => {
      forget(event.data.id);
    }), context.data.on("form.cancelled", event => {
      forget(event.data.id);
    })];
    const offSlot = context.ui.slot({
      append: "session.composer.top",
      render: input => _$createComponent(Countdown, {
        context: context,
        get sessionID() {
          return input.sessionID;
        },
        tracked: tracked,
        now: now,
        adopt: adopt
      })
    });

    /**
     * The keymap observer lives in an `app` slot render so it has a Solid owner
     * to register under and stays mounted across session switches. See
     * `KeymapObserver` for why it cannot be registered from `setup`.
     */
    const offKeymapSlot = config.cancelOnInteraction ? context.ui.slot({
      append: "app",
      render: () => _$createComponent(KeymapObserver, {
        context: context,
        tracked: tracked,
        cancel: release
      })
    }) : undefined;
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      offKeymapSlot?.();
      offSlot();
      clearInterval(ticker);
    };
  }
});
