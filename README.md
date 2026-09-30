# Notar

Browser-based melody composer with scrolling grand-staff notation and Web Audio playback.

**Live:** [eliasv.com/projects/notar/](https://eliasv.com/projects/notar/)

- Range C2–C6 (four octaves plus the top C), chromatic, Nordic pitch names (H = B).
- Middle C and up are written on the treble staff, lower notes on the bass staff,
  with ledger lines and measure-scoped accidentals.
- The keyboard is one continuous row of octave groups; it scrolls horizontally
  (with an octave switcher) when it does not fit, and shows every octave on wide screens.

## Shortcuts

| Key | Action |
| --- | --- |
| `A S D F G H J` | C D E F G A H in the active octave |
| `W E T Y U` | C♯ D♯ F♯ G♯ A♯ |
| `K` | C of the next octave |
| `Z` / `X` | Active octave down / up |
| `Space` | Rest |
| `Enter` / `Esc` | Play / stop |
| `Backspace` | Undo |

## Development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Tests

```bash
node tests/smoke.cjs
```

Puppeteer smoke test across phone, iPad (portrait and landscape) and desktop sizes.
It finds puppeteer in this repo, in the parent portfolio checkout (`../../node_modules`),
or at `$PUPPETEER_MODULE`.
