# Enable spoken narration

Spoken narration is **off by default** — TTS controls only appear in the narration pane once you turn it on.

To enable it:

1. Open VS Code Settings (`Ctrl+,` / `Cmd+,`).
2. Search for **`codeNarration.speech.enabled`**.
3. Check the box.

Or run **Preferences: Open User Settings (JSON)** and add:

```jsonc
{
  "codeNarration.speech.enabled": true
}
```

Once enabled, the narration pane's banner will show **Play / Pause / Stop**, a voice picker, and a rate slider.
