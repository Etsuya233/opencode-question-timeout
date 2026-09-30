import assert from "node:assert/strict"
import { test } from "node:test"

import {
  answerableFields,
  autoAnswer,
  describeAutoAnswer,
  fieldLabel,
  firstValue,
  FORM_MODE,
  INTERACTION_KEYS,
  isQuestionForm,
  readTimeout,
  secondsLeft,
  type Form,
} from "./question.ts"

/**
 * Fixtures mirror what the `question` tool actually produces
 * (`packages/core/src/tool/plugin/question.ts`): fields keyed `q0`, `q1`, ...
 * where a single-choice question is a `string` field carrying `options` and a
 * `multiple: true` question is a `multiselect`.
 */
function question(fields: Form["fields"]): Form {
  return {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
    fields,
  }
}

const OPTIONS = [
  { value: "Use Bun", label: "Use Bun" },
  { value: "Use pnpm", label: "Use pnpm" },
]

test("isQuestionForm only accepts forms the question tool tagged", () => {
  assert.equal(isQuestionForm(question([{ key: "q0", type: "string", options: OPTIONS }])), true)

  // OAuth, MCP elicitation and any future form producer share this mechanism.
  // Replying to one of those with a first-option guess would be wrong, so the
  // metadata tag is the only thing we trust.
  assert.equal(
    isQuestionForm({ id: "frm_2", sessionID: "ses_1", title: "Authorize", fields: [{ key: "a", type: "boolean" }] }),
    false,
  )
  assert.equal(
    isQuestionForm({
      id: "frm_3",
      sessionID: "ses_1",
      title: "Questions",
      metadata: { kind: "something-else" },
      fields: [{ key: "q0", type: "string", options: OPTIONS }],
    }),
    false,
  )
})

test("firstValue picks the first option, wrapped for multiselect", () => {
  assert.equal(firstValue({ key: "q0", type: "string", options: OPTIONS }), "Use Bun")
  // A multiselect answer must be an array; the server rejects a bare string.
  assert.deepEqual(firstValue({ key: "q0", type: "multiselect", options: OPTIONS }), ["Use Bun"])
  assert.equal(firstValue({ key: "q0", type: "string" }), undefined)
  assert.equal(firstValue({ key: "q0", type: "string", options: [] }), undefined)
})

test("firstValue falls back for boolean and defaulted multiselect fields", () => {
  assert.equal(firstValue({ key: "q0", type: "boolean", default: false }), false)
  assert.equal(firstValue({ key: "q0", type: "boolean" }), true)
  assert.deepEqual(firstValue({ key: "q0", type: "multiselect", default: ["a", "b"] }), ["a", "b"])
  // An empty default carries no answer to reuse.
  assert.equal(firstValue({ key: "q0", type: "multiselect", default: [] }), undefined)
})

test("answerableFields skips external, hidden and conditional fields", () => {
  const fields = answerableFields(
    question([
      { key: "q0", type: "string", options: OPTIONS },
      { key: "ext", type: "external", url: "https://example.com" } as never,
      { key: "hidden", type: "string", options: OPTIONS, hidden: true },
      // A `when` can only be evaluated against answers that do not exist yet,
      // and the server rejects answers for fields it considers inactive.
      { key: "cond", type: "string", options: OPTIONS, when: [{ key: "q0", op: "eq", value: "Use Bun" }] },
    ]),
  )
  assert.deepEqual(
    fields.map((f) => f.key),
    ["q0"],
  )
})

test("autoAnswer answers every question field with its first option", () => {
  const answer = autoAnswer(
    question([
      { key: "q0", type: "string", options: OPTIONS },
      { key: "q1", type: "multiselect", options: [{ value: "docs", label: "docs" }] },
    ]),
  )
  assert.deepEqual(answer, { q0: "Use Bun", q1: ["docs"] })
})

test("autoAnswer returns undefined when nothing can be answered", () => {
  // An external-only form has no first option, so there is no reply to send.
  assert.equal(autoAnswer(question([{ key: "ext", type: "external", url: "https://example.com" } as never])), undefined)
  assert.equal(autoAnswer(question([{ key: "q0", type: "string" }])), undefined)
})

test("describeAutoAnswer names the pick and counts the rest", () => {
  assert.equal(describeAutoAnswer(question([{ key: "q0", type: "string", options: OPTIONS }])), "Use Bun")
  assert.equal(
    describeAutoAnswer(
      question([
        { key: "q0", type: "string", options: OPTIONS },
        { key: "q1", type: "string", options: OPTIONS },
        { key: "q2", type: "string", options: OPTIONS },
      ]),
    ),
    "Use Bun (+2 more)",
  )
  assert.equal(describeAutoAnswer(question([{ key: "q0", type: "string" }])), undefined)
})

test("fieldLabel prefers title, then first option, then the key", () => {
  assert.equal(fieldLabel({ key: "q0", type: "string", title: "Package manager", options: OPTIONS }), "Package manager")
  assert.equal(fieldLabel({ key: "q0", type: "string", title: "  ", options: OPTIONS }), "Use Bun")
  assert.equal(fieldLabel({ key: "q0", type: "string" }), "q0")
})

test("secondsLeft clamps at zero and rounds up", () => {
  assert.equal(secondsLeft(10_000, 0), 10)
  assert.equal(secondsLeft(10_000, 1), 10)
  // 9_001ms left is 9.001s, which must read as "10s" not "9s".
  assert.equal(secondsLeft(10_000, 999), 10)
  assert.equal(secondsLeft(10_000, 5_000), 5)
  assert.equal(secondsLeft(10_000, 10_000), 0)
  // Past the deadline the display must never show a negative.
  assert.equal(secondsLeft(10_000, 99_000), 0)
})

test("readTimeout treats 0 and false as off, and bad values as the default", () => {
  assert.equal(readTimeout(5_000, 120_000), 5_000)
  assert.equal(readTimeout("5000", 120_000), 5_000)
  assert.equal(readTimeout(0, 120_000), 0)
  assert.equal(readTimeout(false, 120_000), 0)
  // A typo must not silently disarm the safety net.
  assert.equal(readTimeout("soon", 120_000), 120_000)
  assert.equal(readTimeout(-1, 120_000), 120_000)
  assert.equal(readTimeout(undefined, 120_000), 120_000)
  assert.equal(readTimeout(Number.NaN, 120_000), 120_000)
})

test("INTERACTION_KEYS covers every way the form prompt can be driven", () => {
  // These mirror the host's own form bindings. If OpenCode renames or adds one,
  // this test is the place that should fail and prompt an update.
  const keys = new Set(INTERACTION_KEYS)

  // Cursor movement and direct jumps.
  for (const key of ["up", "down", "k", "j", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    assert.ok(keys.has(key), `missing ${key}`)
  }
  // Field switching and committing.
  for (const key of ["left", "right", "h", "l", "tab", "shift+tab", "return", "space"]) {
    assert.ok(keys.has(key), `missing ${key}`)
  }
  // `escape` dismisses the form, which already emits `form.cancelled`.
  assert.equal(keys.has("escape"), false)
  // Binding a key twice would register two identical bindings for it.
  assert.equal(keys.size, INTERACTION_KEYS.length)
})

test("FORM_MODE matches the mode the host pushes for a form prompt", () => {
  assert.equal(FORM_MODE, "form")
})
