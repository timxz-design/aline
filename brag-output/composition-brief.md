# Hyperframes Composition Brief: ALINE

## Objective
Create a short launch-style brag video for ALINE — a personal AI agent that coordinates the life you have outside work.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: `C:\Users\nikni\Desktop\aline project\aline-app`
- Primary files read: `README.md`, `package.json`, `app.json`, `src/theme/index.ts`, `app/(app)/agent.tsx`, `app/(app)/events.tsx`, `src/components/EventCard.tsx`, `assets/icon.png`
- Product name: ALINE
- Tagline / strongest claim: "Your personal AI agent. Coordinates hangouts with your friend groups by talking to other people's agents."
- Key UI moment to recreate: the ALINE chat screen on warm paper — wordmark header with teal `Events` / `Goals` pills, a one-line agent reply, and event cards arriving beneath it with a teal `I'm going` pill. Then the week view where a movable block slides aside.
- Copy that must appear verbatim:
  - "Everyone's free."
  - "Nobody makes the plan."
  - "what's happening this weekend?"
  - "Two things on this weekend."
  - "I'm going"
  - "It moves what can move."
  - "Your agent makes it happen."

## Creative Direction
- Tone preset: `polished`
- Creative direction: quiet premium product film — warm paper, calm confidence, the agent doing the work while the user barely lifts a finger
- Interpretation: fewer scenes, longer holds, crisp entrances. Energy comes from one decisive motion (the schedule block sliding), not from fast cutting. The product's own stated philosophy is "calm, anti-addictive: no bright reds, no urgent notification colours, no gamification" — the video must obey the same rule.
- Angle: Every shared-calendar app shows you when everyone is free. None of them make anything happen. ALINE's agent does the asking, the suggesting, and — the part nobody else does — the moving. The whole video lands one idea: a calendar reads your life; ALINE rearranges it.
- Hook: warm paper, no UI, two lines settling — "Everyone's free." then "Nobody makes the plan."
- Outro / punchline: the ALINE mark on warm paper with "Your agent makes it happen."
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign
  - Anything that reads as urgent, gamified, or attention-demanding (contradicts the brand)

## Visual Identity
- Background: `#F5F1EA` (warm paper)
- Card surface: `#FFFFFF`
- Text: `#1C3A3B` (deep teal-charcoal)
- Muted text: `#5D6E6C`
- Dim text: `#93A09D`
- Accent: `#2E7D78` (deep teal)
- Accent wash: `#DFEDE8` (mint — selected/going state)
- Secondary: `#6C8CE8` (periwinkle)
- Flexible-event green: `#2E9E6B` (the movable block)
- Display font: light geometric sans, wide letterspacing (matches the ALINE wordmark). Fallback: system sans with increased letter-spacing.
- Body font: system sans (SF Pro / Inter / Segoe UI) — the app ships system type, no webfont
- Border radius language: cards `10px`, pills fully rounded (`999px`)
- Visual references from the project:
  - `assets/icon.png` — the infinity mark (teal to periwinkle interlocking loops) on warm paper, 1024x1024
  - `assets/splash-icon.png` — mark + ALINE wordmark lockup
  - Cards separate from background by tone (white on cream), NOT by borders — this is an explicit design decision in the codebase and must be preserved

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. **The problem** — 3.5s — warm paper, two lines land in sequence: "Everyone's free." / "Nobody makes the plan." No UI, no logo. Wide margins.
2. **The ask** — 3.5s — the real chat UI in a phone frame; "what's happening this weekend?" types character by character into the composer; teal send arrow pulses; message posts.
3. **The answer** — 5s — one-line reply "Two things on this weekend.", then two event cards arrive one by one: "Jazz night / Fri 20:30 · Kino Siska · 10 EUR · ~12 min drive" and "Farmers market / Sat 08:00 · Main square · free", each with a teal `I'm going` pill. Both readable together at the end.
4. **The move** — 4.5s — tap `I'm going`; pill flips to mint `Going ✓`; cut to week view where the green "Strength training" block slides Friday → Saturday and a teal "Jazz night" block drops into the freed slot. Caption: "It moves what can move."
5. **Outro** — 3.5s — dissolve to clean warm paper; ALINE mark + wordmark settle; "Your agent makes it happen."

## Audio
- Audio role: warm low bed with sparse, motion-matched accents
- Audio arc: enters quiet under the near-silent hook → small lift when the product appears (~3.70s) → steady through the card reveals with one soft accent per card → quiet weight on the tap and the block landing → fades to silence under the logo over the final ~1.5s
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.84 BPM)
- Music treatment: start at 0:00, low volume under the hook, slight lift at the ~3.70s strong cue, steady body, fade out across the last 1.5s so the logo lands in near-silence
- Music cue guidance: bundled preset at `~/.claude/plugins/cache/brag/brag/0.2.2/skills/brag/assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`. Strong cues to target: **3.70s** (hook → UI), **8.44s** and **10.54s** (the two event cards), **12.65s** (the `I'm going` tap). Beat grid ~0.52s apart; the two card reveals sit ~2.1s apart, well above the reading floor.
- Audio-reactive treatment: subtle — the teal glow around the mark in the outro may breathe with music RMS. Nothing else. No waveform bars, no equalizers, no particles, no pulsing UI.
- Audio-coupled moments:
  - Scene 2 typing — soft key ticks under the character-by-character question, one tap on send
  - Scene 3 card 1 (~8.44s) — one quiet card-arrival accent, beat-locked
  - Scene 3 card 2 (~10.54s) — same accent, beat-locked
  - Scene 4 tap (~12.65s) — one confirming tap, beat-locked; soft settle as the schedule block lands
  - Scene 5 logo — no SFX; music fade only
- SFX selection guidance: sparse and polished. Prefer low high-frequency-risk files. Sound should confirm motion, never announce it. No whooshes, no risers, no notification chimes — if a cue sounds exciting, it is wrong for this brand.
- SFX analysis guidance: `~/.claude/plugins/cache/brag/brag/0.2.2/skills/brag/assets/sfx/sfx-analysis.md` if present
- Exact SFX choice: Hyperframes should choose filenames, timestamps, density, and volume based on the implemented animation.
- Audio files: copy the chosen music and any selected SFX into `brag-output/composition/assets/`

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). This is the `/brag` workflow: do not enter the `hyperframes` entry-point intent interview and do not route into the generic promo / launch-video workflow. Prefer native Hyperframes conventions.

Requirements:
- Show at least one real UI, copy, or visual element from the source project — the chat screen with event cards is the centerpiece.
- Keep all text readable: short labels ~0.8s settled minimum, sentences ~0.3s per word.
- Keep the video within 15-25 seconds (target 20s).
- Include the planned music/SFX layer.
- Treat audio notes as guidance; choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints; ignore cues that hurt readability or pacing.
- Lock 1-3 strong cues within ±0.15s; snap sequential card reveals to the beat grid within ±0.10s.
- Wire at least one subtle audio-reactive visual (outro mark glow) or document extraction failure.
- Use local assets for audio, fonts, and images.
- Run `hyperframes check` before render — it is brag's single gate.

## Environment notes
- FFmpeg/FFprobe: installed this run at `C:\Users\nikni\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin` — must be on PATH for render.
- Chrome: headless shell in the hyperframes cache.
- **Low memory: ~1.1 GB available of 7.9 GB.** Render with conservative worker/concurrency settings; the doctor warns renders may fail at this level.
