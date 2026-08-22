# Localization

The package works without `@juicesharp/rpiv-i18n`; every string falls back to inline English. With the optional peer installed, locale resolution follows the i18n package's configured language and updates an open questionnaire at render time.

Nine locale files ship in `locales/`: `de`, `en`, `es`, `fr`, `pt`, `pt-BR`, `ru`, `uk`, and `zh`.

Translated chrome includes the three sentinel labels, compact returned-thread status/outcome/error text, questionnaire controls, review text, notes, previews, and RPC dialog prompts. Locale files contain only the current compact outcome/error strings for discussion threads.

Model-facing content remains English: tool descriptions, parameter schema descriptions, errors, and reserved-label validation. This keeps tool behavior stable across locales. The fixed English labels `Discuss this` and `Type something.` remain reserved even when their visible labels are localized.

To add a locale:

1. Copy `locales/en.json` to `locales/<code>.json`.
2. Keep every key and its placeholders/symbols.
3. Translate values and restart Pi.

Missing keys safely fall back to English.
