# Configure auto-play

If you want sentences to be spoken **as they stream in** (no clicking Play), enable auto-play:

- Setting: **`codeNarration.speech.autoPlay`**
- Requires `codeNarration.speech.enabled` to also be `true`.

Other useful speech settings:

| Setting | Range | What it does |
| --- | --- | --- |
| `codeNarration.speech.rate` | 0.5 – 2.0 | Speed multiplier (1.0 = normal). |
| `codeNarration.speech.pitch` | 0 – 2 | Pitch multiplier (1.0 = normal). |
| `codeNarration.speech.voice` | string | Voice name; empty uses the system default. |

The rate slider in the banner edits `codeNarration.speech.rate` live and the change persists across narrations.
