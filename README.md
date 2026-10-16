# Practice Timer — The Allsparks

An unofficial BIOBUZZ practice timer. The clock and sounds run in the browser. Cloudflare only serves the files. This page never starts or stops a robot OpMode.

Timing follows BIOBUZZ TU04, October 8, 2026. The transition speaks every second from 8 to 1. FIRST does not publish the Live field recordings for reuse, so the bundled audio is an original practice pack. See [docs/sound-provenance.md](docs/sound-provenance.md).

## Run locally

From this folder:

```sh
node test/machine.test.mjs
npx --yes serve -l 8766 .
```

Open `http://127.0.0.1:8766/`. Port 8765 is used by Plate Lab. A file URL will not start the timer. To rebuild the practice sounds:

```sh
node scripts/generate-sounds.mjs
```

## Chromebook check

Use 1366×768 and 1280×720 at 100% and 125% zoom.

- Start a short custom drill. Pause, resume, reset, and abort from the buttons.
- Space starts, pauses, or resumes. R resets and asks first when a run is active. F toggles fullscreen. M mutes. Escape leaves fullscreen and does not abort. Abort stays on the screen.
- Mute still moves the clock, phase, and banner.
- After “Offline ready” appears, turn Wi-Fi off and reload. The timer should open from the cache.
- Switch away from the tab, or reload during a run. The page should say “Practice interrupted—restart or resume.” It should not continue by itself and should not play sounds that were skipped.

The logical clock is covered by `node test/machine.test.mjs`. A full 158-second listen on the Chromebook speaker is still a separate shop check.

## Deploy

```sh
npx wrangler login
npx wrangler deploy
```

`wrangler.jsonc` uses Workers Static Assets only, under the name `practice-timer`. There is no Worker script. Static asset requests are free under Cloudflare’s current policy: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
