# Pick a voice

The narration pane uses your operating system's installed speech voices via the **Web Speech API**.

There are two ways to pick a voice:

- **In the narration pane**: use the voice dropdown in the speech controls banner. Selecting a voice persists immediately.
- **Command Palette**: run **Code Narration: Pick Voice** to choose from a searchable quick-pick of every voice the pane currently knows about. The current selection is pre-marked.

If you run the command before opening a narration, you'll get a free-text fallback so the command always works from the palette.

The chosen voice is stored in `codeNarration.speech.voice` (empty = system default).
