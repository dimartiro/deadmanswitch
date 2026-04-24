# Estate Protocol — 5-min presentation

Reveal.js 5.1 deck. 10 slides, speaker notes per slide, mermaid diagrams on every content slide, cyberpunk-terminal palette matching the frontend. Everything from CDN — no install, no build.

## Run

```bash
cd presentation
python3 -m http.server 8000
# or: npx --yes serve .
```

Open [`http://localhost:8000`](http://localhost:8000).

## Speaker modep

| Key | What it does |
|---|---|
| `S` | Open the speaker view (next slide + timer + notes). |
| `Esc` | Slide overview. |
| `B` | Black out the screen. |
| `F` | Fullscreen. |
| `←` `→` / `Space` | Navigate. |

## Slides & target timing (5 min)

| # | Slide | Target |
|---|---|---|
| 1 | Title | 10 s |
| 2 | Problem — keys die with you | 35 s |
| 3 | Solution — programmable will | 35 s |
| 4 | Architecture — 3 chains | 45 s |
| 5 | XCM — sequence diagram | 40 s |
| 6 | Identity — People Chain | 30 s |
| 7 | Economics — fee router + flat-capped reward | 40 s |
| 8 | DEMO (title only) | 5 s |
| 9 | Live frontend iframe | 55 s |
| 10 | What's next / thank you | 15 s |

## Demo slides

Slide 8 is a chromeless **DEMO** hero. Slide 9 embeds `http://localhost:5173/#/` as a full-viewport iframe with `data-background-interactive` — click straight inside the slide to drive the app.

Before presenting, start the stack:

```bash
./scripts/start-zombienet.sh         # terminal 1
./scripts/start-frontend.sh          # terminal 2
```

Happy-path demo (≤55 s):

1. Wills dashboard — show counts.
2. New will → Alice owner, 1-minute interval, Transfer 1 ROC to Bob. Point at the live Protocol-fee preview.
3. Sign. Row appears in the dashboard.
4. Switch to Bob — "names you" chip.
5. If time: let one expire, click Trigger from a third account, show the reward toast.

If the node is down, stay on slide 8 and narrate from the speaker notes — slide 9 will just show a blank iframe.

## Style

- `styles.css` — all palette / typography overrides (cyberpunk neon on near-black, Oxanium display + JetBrains Mono body).
- Mermaid themed via `themeVariables` to match (neon-green strokes, magenta for failure paths).
- Scanline overlay at screen level for the terminal feel.
