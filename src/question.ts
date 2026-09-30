/**
 * Pure decision logic for the question countdown.
 *
 * Everything here is deliberately free of Solid, OpenTUI and plugin imports so
 * it can be unit tested with `node --test` alone. The TUI entry wires these
 * functions to reactive signals and to `context.data.session.form`.
 *
 * Background: OpenCode V2 has no "question" concept of its own. The `question`
 * tool is a thin producer of a **Form** (`packages/core/src/tool/plugin/question.ts`),
 * and it tags the form it creates with `metadata.kind === "question"`. Each
 * question becomes one field keyed `q0`, `q1`, ... — a `string` field carrying
 * `options` for a single choice, or a `multiselect` field when the model asked
 * `multiple: true`. Forms are the same mechanism OAuth login and MCP
 * elicitation use, which is why every predicate below filters on the tag rather
 * than assuming any form on screen is a model question.
 */

/** One visibility condition on a field. Mirrors `Form.When`. */
export type When = { key: string; op: "eq" | "neq"; value: string | number | boolean }

/** The subset of a form field this plugin needs. Mirrors `Form.Field`. */
export type Field = {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  /** Short label. The question tool sets it from the prompt's `header`. */
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: ReadonlyArray<When>
  options?: ReadonlyArray<{ value: string; label: string; description?: string }>
  default?: unknown
}

/** The subset of `Form.Info` this plugin needs. */
export type Form = {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: ReadonlyArray<Field>
}

export type AnswerValue = string | number | boolean | ReadonlyArray<string>
export type Answer = Record<string, AnswerValue>

/**
 * A form is a model question only when the `question` tool tagged it.
 *
 * The tag is the sole discriminator: form id prefixes, titles and field shapes
 * are all shared with non-question forms, and replying to one of those with a
 * first-option guess would be actively wrong (an OAuth form wants a real
 * consent decision, not a timeout).
 */
export function isQuestionForm(form: Form): boolean {
  return form.metadata?.["kind"] === "question"
}

/**
 * Every field the timeout can answer on its own.
 *
 * `external` fields point at a URL the human has to visit and can only be
 * acknowledged with `true`, so they are excluded rather than guessed. `hidden`
 * fields are excluded because the interactive prompt skips them too.
 *
 * Fields guarded by `when` are excluded as well. A condition can only be
 * evaluated against answers that do not exist yet, and OpenCode's validator
 * rejects an answer for a field it considers inactive — so filling a
 * conditional field speculatively is more likely to fail the whole reply than
 * to help it. The `question` tool never emits `when`, so this costs nothing in
 * practice and keeps the plugin honest for any future form shape.
 */
export function answerableFields(form: Form): ReadonlyArray<Field> {
  return form.fields.filter(
    (field) => field.type !== "external" && field.hidden !== true && (field.when?.length ?? 0) === 0,
  )
}

/**
 * The value that stands in for "the first option" on one field.
 *
 * Returns `undefined` when the field has no first option to fall back to, which
 * is the signal to leave that field out of the answer entirely. A `boolean` has
 * no options at all, so it falls back to its own `default`, and finally to
 * `true` — a field with a declared default and no options can only be asking
 * for a boolean.
 */
export function firstValue(field: Field): AnswerValue | undefined {
  const first = field.options?.[0]
  if (first) return field.type === "multiselect" ? [first.value] : first.value
  if (field.type === "boolean") return typeof field.default === "boolean" ? field.default : true
  if (field.type === "multiselect" && Array.isArray(field.default) && field.default.length > 0) return field.default
  return undefined
}

/**
 * Build the reply that answers every answerable field with its first option.
 *
 * Returns `undefined` when nothing can be answered, so the caller can skip the
 * request entirely rather than send an empty answer the server would reject.
 */
export function autoAnswer(form: Form): Answer | undefined {
  const answer: Answer = {}
  let count = 0
  for (const field of answerableFields(form)) {
    const value = firstValue(field)
    if (value === undefined) continue
    answer[field.key] = value
    count++
  }
  return count > 0 ? answer : undefined
}

/** A short human label for one field, used in the timeout notice. */
export function fieldLabel(field: Field): string {
  const title = typeof field.title === "string" ? field.title.trim() : ""
  if (title) return title
  const label = field.options?.[0]?.label
  return typeof label === "string" && label.trim() ? label.trim() : field.key
}

/**
 * What the timeout will pick, for the notice shown while the clock runs.
 *
 * Only the first field is described: a notice that lists every option of every
 * question would wrap over the prompt it sits above.
 */
export function describeAutoAnswer(form: Form): string | undefined {
  const fields = answerableFields(form)
  const first = fields[0]
  if (!first) return undefined
  const value = firstValue(first)
  if (value === undefined) return undefined
  const chosen = Array.isArray(value) ? value[0] : value
  if (typeof chosen !== "string") return fieldLabel(first)
  const rest = fields.length - 1
  return rest > 0 ? `${chosen} (+${rest} more)` : chosen
}

/** Whole seconds left, clamped at 0 so the display never shows a negative. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/** Parse a duration in milliseconds from a plugin option. */
export function readTimeout(value: unknown, fallback: number): number {
  if (value === false || value === 0) return 0
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.round(parsed)
}

/**
 * The input mode the host pushes while a form prompt owns the keyboard.
 *
 * `FormPrompt` does `keymap.mode.push("form")` on mount, so a layer scoped to
 * this mode is live exactly while a question is on screen and inert otherwise.
 * The string is not part of the documented plugin API, so it is kept in one
 * place: if OpenCode ever renames the mode, the countdown silently stops
 * reacting to keys rather than swallowing them.
 */
export const FORM_MODE = "form"

/**
 * Every key the host's form prompt uses to move around or commit an answer.
 *
 * Derived from the three layers in `packages/tui/src/routes/session/form.tsx`:
 * `up`/`down`/`k`/`j` move the cursor, `1`-`9` jump straight to an option,
 * `left`/`right`/`h`/`l`/`tab`/`shift+tab` change field, and `return`/`space`
 * select or toggle.
 *
 * `escape` is deliberately absent. It dismisses the form, which already emits
 * `form.cancelled` — the same event that stops the clock when the user submits
 * an answer. Binding it here would be a second, redundant path to the same
 * outcome.
 *
 * The host layers that own these keys are themselves conditional (the `h`/`j`
 * bindings switch off while a custom answer is being typed). This layer does
 * not need to mirror that: a rejected binding falls through to the next
 * candidate and, when nothing handles it, the key is left un-consumed and still
 * reaches the textarea. So binding the full set only ever *adds* the
 * observation, never a keystroke the user could not already make.
 */
export const INTERACTION_KEYS: ReadonlyArray<string> = [
  "up",
  "down",
  "k",
  "j",
  "left",
  "right",
  "h",
  "l",
  "tab",
  "shift+tab",
  "return",
  "space",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]
