# ☢ SPIDERTEC SONIC TRANSFER PROTOCOL — MODEL SS-1200

Transferring files with **sound**. One computer plays a file through its speakers,
the other listens through a microphone and reconstructs it. A Pip-Boy/Fallout-style
interface — an oscilloscope, a spectrum analyzer, knobs for everything, selectable
error correction (Reed–Solomon / XOR), full-spectrum band auto-tuning, and a
visual per-tone equalizer.

## Running

```bash
npm install
npm start
```

## How to use

**TRANSMIT mode:**
1. `SELECT PAYLOAD FILE` — pick a file (ideally up to ~2 KB, since this is a slow channel).
2. Set the parameters (or leave the defaults).
3. `TRANSMIT` — the file goes out through the speakers. Or `SAVE .WAV` to save the audio.

**RECEIVE mode:**
1. Set the **same** parameters as the transmitter (BASE FREQ, TONE SPACING, SYMBOL DURATION).
2. `ARM RECEIVER` — grant microphone access.
3. Start transmitting on the other device (or play back a saved `.wav`).
4. After reception: preview + `SAVE FILE`. CRC32 confirms integrity.

> Testing without two machines: click `SAVE .WAV`, then `ARM RECEIVER` and play that file
> from any player next to the microphone.

## Parameters (UI)

| Knob | What it does |
|---|---|
| **SYMBOL DURATION** | Duration of one symbol. Shorter = faster, but less robust. |
| **SYMBOL GAP** | Silent gap inserted between symbols. Lets reverb/echo tails die down before the next tone (can cut inter-symbol interference in a live room); costs transmission time. Must match on both sides. 0 = back-to-back. |
| **BASE FREQ** | Frequency of the first of the 16 data tones. |
| **TONE SPACING** | Spacing between tones. Wider = more noise-resistant. |
| **MODULATION** | Bits per symbol → 2^bits FSK tones (4-FSK … 64-FSK). 16-FSK (4 bit) is the robust default; higher packs more bits per tone (faster) but needs a clean, wide channel since the tones crowd together. Must match both sides — run FIND BAND first so all 2^bits tones fit. |
| **OUTPUT GAIN** | Transmit volume. |
| **ERROR CORRECTION** | Correction mode: **REED–SOLOMON** (fixes real byte errors — most reliable), **XOR-FEC** (XOR parity, only repairs "erasures" — low-confidence symbols, one per block), **NONE**. The mode and strength travel in the header → the receiver adapts on its own. |
| **RS PARITY / REPAIR DENSITY** | Correction strength. RS: parity bytes per codeword (fixes half that many errors). XOR: `1:N` parity per N nibbles. |
| **INPUT GAIN** | (receive) Gain on the microphone signal — for the scopes and the demodulator. |
| **ERASURE THRESH** | (receive) Confidence threshold below which a symbol is "erased" and becomes a candidate for repair. |
| **RESET** | (receive) Aborts the current decode (e.g. when a transmission gets stuck) and clears the result. |
| **TEST SIGNAL** | (transmit) Sends a built-in test frame — checks the whole link without picking a file. |
| **SYNC TONE** | (transmit) Holds a continuous sync tone — for calibrating volume and watching the SYNC LOCK bar. |
| **CALIBRATE** | Channel tuning: the transmitter plays a sync tone + a sweep of the 16 tones, and a receiver armed with `CALIBRATE` uses the received tone levels to auto-set **INPUT GAIN** and compute a **per-tone equalizer (EQ)** that compensates for frequency attenuation. |
| **FIND BAND** | Full-spectrum auto-tuning: the transmitter plays a wide sweep (~600–4800 Hz); a receiver armed with `FIND BAND` measures the channel response across the whole range, picks the **optimal data band** (auto-applying it on the receive side), and shows the **BASE FREQ / TONE SPACING** to set on the transmitter. The sync tone is derived as `BASE FREQ − 200 Hz`, so relaying just those two values is enough. |
| **SYNC LOCK** (bar) | (receive) Real-time strength of the received lead-in tone. The amber tick = the lock threshold; above it the bar lights up. |

## How it works

- **Modulation:** M-FSK — each symbol is one of `M = 2^bits` pure tones (selectable
  4-FSK … 64-FSK; 16-FSK / 4 bits is the default). The byte stream is packed MSB-first
  into B-bit symbols, so any width works. Higher orders are faster but pack the tones
  closer together, so they need a clean, wide channel.
- **Synchronization:** a lead-in tone below the data band (`BASE FREQ − 200 Hz`); the
  receiver catches the falling edge and sets its symbol clock. Because the sync tone
  is derived from `BASE FREQ`, moving the data band moves the sync tone with it — so
  `FIND BAND` can relocate the whole link away from a dead spot in the channel.
- **Timing recovery:** after lock, the receiver re-centres each symbol on the local
  energy peak and feeds a fraction of that nudge back into its symbol clock. This
  tracks the small sample-rate mismatch between the playback and capture devices, so
  the demod window can't slowly drift off the tones over a long frame.
- **Size descriptor:** right after the sync tone, a small header (frame size +
  correction mode + CRC8) is sent **repeated 3×**. By majority vote the receiver
  reliably determines how many symbols to receive — regardless of noise in the rest
  of the signal.
- **Robustness:** if the overall CRC32 doesn't match, the receiver **does not stop** —
  it saves what it received, marks it as corrupted, and keeps listening.
- **Frame:** `"SS"` + version + flags + block size + name + length + data + **CRC32**.
- **Error correction (selectable):**
  - **Reed–Solomon** (default) — GF(256), the frame is split into codewords ≤255 B with
    `P` parity bytes each; fixes up to `P/2` **real** byte errors per codeword, without
    relying on symbol "confidence". This also catches confident-but-wrong reads that
    XOR can't touch.
  - **XOR-FEC** — parity nibbles (XOR per block) follow the data on the normal band.
    Repairs one low-confidence symbol (erasure) per block.
  - **CRC32** always verifies the whole thing — if correction can't keep up, you'll know.
- **Demodulation:** Goertzel filters on the 16 known frequencies (cheap, accurate).

## Correctness test (no audio)

```bash
node test/loopback.js
```

Verifies the round-trip for text and binary, noise resilience, and FEC repair.

## Files

- `main.js` — Electron main process (window, microphone permission).
- `src/modem.js` — modem core (encoder, Goertzel, CRC, FEC). Pure JS, no DOM.
- `src/app.js` — UI, audio engine, streaming receiver, visualizations.
- `src/index.html`, `src/styles.css` — the CRT interface.
- `test/loopback.js` — offline self-test.
