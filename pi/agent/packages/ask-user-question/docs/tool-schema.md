# Tool schema and results

## Parameters

```ts
ask_user_question({
  questions: [{
    question: string,
    header: string,                 // max 16 characters
    options: [{
      label: string,                // max 60 characters
      description: string,
      preview?: string,
    }],                             // 2–4 options
    multiSelect?: boolean,
  }],                               // 1–4 questions
})
```

`"Other"`, `"Discuss this"`, `"Type something."`, and `"Next"` are reserved option labels. They are rejected with `reserved_label` in every question mode.

## Result

```ts
{
  content: [{ type: "text", text: string }],
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,
      selected?: string[],
      notes?: string,
      preview?: string,
    }>,
    cancelled: boolean,
    outcome?: "handoff",
    discussions?: Array<{
      questionIndex: number,
      question: string,
      thread: {
        sessionFile: string,
        sessionId?: string,
        parentSessionFile: string,
        forkAnchorId: string,
        parentToolCallId: string,
      },
      outcome?: string,
      classification?: "context_only" | "single_option" | "multi_options" | "custom_answer",
      suggestion?: { kind: "option" | "multi" | "custom", optionLabels?: string[], customAnswer?: string },
      messages: Array<{ role: "user" | "assistant", text: string, truncated?: boolean }>,
      truncated?: boolean,
      usage: Usage,
    }>,
    discussionUsage?: Usage,
    handoff?: {
      questionIndex: number,
      question: string,
      options: Array<{ label: string, description: string }>,
      reason: string,
      transcript: Array<{ role: "user" | "assistant", text: string }>,
      partialAnswers: QuestionAnswer[],
    },
    error?: QuestionnaireError,
  },
  usage?: Usage,
  terminate?: true,
}
```

Terminal discussion context is bounded and observable-only. It excludes thinking and binary/image content. `discussionUsage` and top-level `usage` aggregate normal child conversation plus `/resolve` classification usage, so Pi session totals account for it once.

A successful `/resolve` does not answer the question by itself. `single_option`, `multi_options`, and `custom_answer` are suggestions that the user confirms in the normal questionnaire controls. `context_only` changes no candidate answer.

## Handoff

Only RPC/ACP **Discuss this** creates a handoff. It returns `cancelled: false`, `outcome: "handoff"`, queues one normal-chat steering message, and sets `terminate: true`. It is never the decline path.

## Errors and events

Validation and UI errors retain the existing `QuestionnaireError` values: `no_ui`, `no_custom_ui`, `no_questions`, `empty_options`, `too_many_questions`, `duplicate_question`, `duplicate_option_label`, `reserved_label`, `session_load_failed`, and `stale_module_cache`.

The package emits `rpiv:ask-user:prompt` after validation and `rpiv:ask-user:blocked` for the full parent questionnaire lifetime, including the interval while a terminal child owns the terminal. These public events describe questionnaire state; consumers define any status behavior.
