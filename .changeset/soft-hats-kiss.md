---
"@chat-adapter/telegram": patch
---

Add Telegram adapter runtime modes (`auto`, `webhook`, `polling`) with safer auto fallback behavior, expose `adapter.resetWebhook(...)` and `adapter.runtimeMode`, switch polling config to `longPolling`, and fix initialization when the chat username is missing.
