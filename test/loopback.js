/* Offline self-test: encode -> (optional noise/corruption) -> decode.
 * Validates framing, CRC and XOR-FEC repair without audio hardware. */
const Modem = require('../src/modem.js');

// deterministic pseudo-noise so the suite is reproducible
let _seed = 1337;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

function decode(pcm, cfg, erasureThresh = 1.8, s0Override, tracked) {
  const sr = cfg.sampleRate;
  const Ns = Math.round(cfg.symbolMs / 1000 * sr);
  const S = Ns + Math.round((cfg.gapMs || 0) / 1000 * sr);   // symbol stride incl. gap
  const Nsync = Math.round(cfg.syncMs / 1000 * sr);
  const s0 = (s0Override != null) ? s0Override : Nsync;
  const bits = cfg.bits || 4;
  const maxJit = tracked ? Math.floor(Ns * 0.4) : 0;
  let drift = 0;
  const readSym = (slotIdx) => {
    const center = s0 + slotIdx * S + Math.floor(Ns / 2) + Math.round(drift);
    const d = Modem.demodSymbolAligned(pcm, center, cfg, null, maxJit);
    if (tracked && d.conf > 1.5) drift += 0.5 * d.offset;   // track the symbol clock
    return d;
  };

  // read the size descriptor (descSymbols leading symbols), then the payload
  const off = Modem.descSymbols(bits);
  const descN = [];
  for (let i = 0; i < off; i++) descN.push(readSym(i).sym);
  const desc = Modem.parseDescriptor(descN, bits);
  const mode = desc.mode, param = desc.param || 16, frameBytes = desc.frameBytes;
  const expected = Modem.ecPlan(frameBytes, mode, param, bits).totalSymbols;

  const nibbles = [], confs = [];
  for (let k = 0; k < expected; k++) {
    const center = s0 + (off + k) * S + Math.floor(Ns / 2) + Math.round(drift);
    if (center >= pcm.length) break;   // goertzel clamps a partial trailing window
    const d = readSym(off + k);
    nibbles.push(d.sym); confs.push(d.conf);
  }

  const recon = Modem.ecReconstruct(nibbles, confs, frameBytes, mode, param, erasureThresh, bits);
  const bytes = recon.frame;
  const nameLen = bytes[5], o = 6 + nameLen;
  const dataLen = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
  const dataStart = 6 + nameLen + 4;
  const data = bytes.subarray(dataStart, dataStart + dataLen);
  const name = Buffer.from(bytes.subarray(6, 6 + nameLen)).toString();
  const crcStored = ((bytes[dataStart + dataLen] << 24) | (bytes[dataStart + dataLen + 1] << 16)
    | (bytes[dataStart + dataLen + 2] << 8) | bytes[dataStart + dataLen + 3]) >>> 0;
  const crcCalc = Modem.crc32(bytes.subarray(0, dataStart + dataLen));
  return { name, data, ok: crcStored === crcCalc, repaired: recon.repaired };
}

// overwrite one whole DATA symbol with a clean (confident) but wrong tone.
// dataSymIndex is relative to the payload (after sync + size descriptor).
function writeSymbol(pcm, cfg, dataSymIndex, nibble) {
  const Ns = Math.round(cfg.symbolMs / 1000 * cfg.sampleRate);
  const S = Ns + Math.round((cfg.gapMs || 0) / 1000 * cfg.sampleRate);
  const Nsync = Math.round(cfg.syncMs / 1000 * cfg.sampleRate);
  const start = Nsync + (Modem.DESC.SYMBOLS + dataSymIndex) * S, f = cfg.f0 + nibble * cfg.spacing;
  for (let i = 0; i < Ns; i++) pcm[start + i] = Math.sin(2 * Math.PI * f * i / cfg.sampleRate) * 0.3;
}

function addNoise(pcm, amp) {
  for (let i = 0; i < pcm.length; i++) pcm[i] += (rnd() * 2 - 1) * amp;
}

// stretch a buffer by factor f (linear resample) — simulates the capture clock
// running at a slightly different rate than the playback clock (symbol drift).
function resample(pcm, f) {
  const out = new Float32Array(Math.round(pcm.length * f));
  for (let i = 0; i < out.length; i++) {
    const x = i / f, i0 = Math.floor(x), t = x - i0;
    out[i] = (pcm[i0] || 0) * (1 - t) + (pcm[i0 + 1] || 0) * t;
  }
  return out;
}

// replicate the receiver's per-tone EQ measurement on a calibration sweep
function measureEq(pcm, cfg, s0) {
  const sr = cfg.sampleRate, Tcal = Math.round(Modem.CAL.toneMs / 1000 * sr);
  const slots = Modem.CAL.repeats * 16, use = Math.floor(Tcal * 0.6);
  const energy = new Array(16).fill(0), cnt = new Array(16).fill(0);
  for (let j = 0; j < slots; j++) {
    const tone = j % 16, center = s0 + j * Tcal + Math.floor(Tcal / 2), st = center - Math.floor(use / 2);
    energy[tone] += Modem.goertzel(pcm, st, use, Modem.dataFreq(cfg, tone), sr); cnt[tone]++;
  }
  for (let k = 0; k < 16; k++) energy[k] /= Math.max(1, cnt[k]);
  const mean = energy.reduce((a, b) => a + b, 0) / 16;
  return energy.map(e => Math.min(4, Math.max(0.25, mean / (e + 1e-12))));
}
function attenuateTone(pcm, cfg, s0, tone, factor) {
  const sr = cfg.sampleRate, Tcal = Math.round(Modem.CAL.toneMs / 1000 * sr), slots = Modem.CAL.repeats * 16;
  for (let j = 0; j < slots; j++) {
    if (j % 16 !== tone) continue;
    const start = s0 + j * Tcal;
    for (let i = 0; i < Tcal; i++) pcm[start + i] *= factor;
  }
}

let pass = 0, fail = 0;
function check(label, cond) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label);
  cond ? pass++ : fail++;
}

// ---- test 1: clean round-trip, text ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const msg = 'Greetings from SpiderTec HQ. The web is holding.';
  const data = new TextEncoder().encode(msg);
  const enc = Modem.encode('note.txt', data, cfg);
  const r = decode(enc.pcm, cfg);
  check('clean: name', r.name === 'note.txt');
  check('clean: crc ok', r.ok);
  check('clean: bytes match', Buffer.from(r.data).toString() === msg);
})();

// ---- test 2: binary payload, no FEC ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.ecMode = 'none';
  const data = new Uint8Array(200); for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;
  const enc = Modem.encode('blob.bin', data, cfg);
  const r = decode(enc.pcm, cfg);
  check('binary: crc ok', r.ok);
  check('binary: length', r.data.length === 200);
  let same = true; for (let i = 0; i < 200; i++) if (r.data[i] !== data[i]) same = false;
  check('binary: bytes match', same);
})();

// ---- test 3: moderate noise still decodes ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const msg = 'noisy channel test 12345';
  const enc = Modem.encode('n.txt', new TextEncoder().encode(msg), cfg);
  addNoise(enc.pcm, 0.05);
  const r = decode(enc.pcm, cfg);
  check('noise: crc ok', r.ok);
})();

// ---- test 4: XOR-FEC repairs a single wiped symbol ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.ecMode = 'xor'; cfg.fecBlock = 16;
  const msg = 'repair me please';
  const enc = Modem.encode('r.txt', new TextEncoder().encode(msg), cfg);
  // wipe one data symbol (zero it out) -> low confidence erasure in block 0
  const Ns = Math.round(cfg.symbolMs / 1000 * cfg.sampleRate);
  const Nsync = Math.round(cfg.syncMs / 1000 * cfg.sampleRate);
  const wipeSym = 14; // a data nibble well inside the frame
  const st = Nsync + (Modem.DESC.SYMBOLS + wipeSym) * Ns;
  for (let i = st; i < st + Ns; i++) enc.pcm[i] = (rnd() * 2 - 1) * 0.02;
  const r = decode(enc.pcm, cfg, 2.5);
  check('fec: repaired >=1', r.repaired >= 1);
  check('fec: crc ok after repair', r.ok);
})();

// ---- test 5: dense XOR FEC (small block) round-trips and repair count scales ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.ecMode = 'xor'; cfg.fecBlock = 4;
  const msg = 'dense repair data test payload';
  const enc = Modem.encode('d.txt', new TextEncoder().encode(msg), cfg);
  const dataNibbles = enc.dataNibbleCount;
  check('dense: parity count = ceil(nibbles/4)', enc.parityCount === Math.ceil(dataNibbles / 4));
  const r = decode(enc.pcm, cfg);
  check('dense: block size travels in header (crc ok)', r.ok);
  check('dense: bytes match', Buffer.from(r.data).toString() === msg);
})();

// ---- test 6: sync detection finds the precise data-start (s0) ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const enc = Modem.encode('s.txt', new TextEncoder().encode('sync alignment check'), cfg);
  const Ns = Math.round(cfg.symbolMs / 1000 * cfg.sampleRate);
  const Nsync = Math.round(cfg.syncMs / 1000 * cfg.sampleRate);
  const r = Modem.scanForSync(enc.pcm, 0, enc.pcm.length, cfg);
  check('sync: found', r.found === true);
  check('sync: s0 within tolerance', Math.abs(r.s0 - Nsync) < Ns * 0.25);
  const dec = decode(enc.pcm, cfg, 1.8, r.s0);
  check('sync: decode from detected s0 ok', dec.ok);
})();

// ---- test 7: sync survives leading silence + noise (offset start) ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const enc = Modem.encode('o.txt', new TextEncoder().encode('offset start test'), cfg);
  const offset = Math.round(0.4 * cfg.sampleRate);
  const buf = new Float32Array(offset + enc.pcm.length);
  for (let i = 0; i < offset; i++) buf[i] = (rnd() * 2 - 1) * 0.03; // room noise
  buf.set(enc.pcm, offset);
  const Ns = Math.round(cfg.symbolMs / 1000 * cfg.sampleRate);
  const Nsync = Math.round(cfg.syncMs / 1000 * cfg.sampleRate);
  const r = Modem.scanForSync(buf, 0, buf.length, cfg);
  check('offset: found', r.found === true);
  check('offset: s0 near offset+Nsync', Math.abs(r.s0 - (offset + Nsync)) < Ns * 0.25);
  const dec = decode(buf, cfg, 1.8, r.s0);
  check('offset: decode ok', dec.ok);
})();

// ---- test 8: Reed-Solomon corrects CONFIDENT symbol errors (XOR can't) ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; // rs default, parity 16 => fixes 8
  const msg = 'Reed-Solomon fixes confident misdecodes 0123456789 abcdef';
  const enc = Modem.encode('rs.txt', new TextEncoder().encode(msg), cfg);
  // overwrite 5 whole symbols with clean but wrong tones (high-confidence errors)
  [12, 33, 57, 80, 101].forEach((idx, i) => writeSymbol(enc.pcm, cfg, idx, (i * 5 + 1) & 15));
  const r = decode(enc.pcm, cfg);
  check('rs: crc ok after correcting confident errors (errs=' + r.repaired + ')', r.ok);
  check('rs: bytes match', Buffer.from(r.data).toString() === msg);
})();

// ---- test 9: too many errors for RS -> CRC still flags it (no silent pass) ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.rsParity = 8; // fixes only 4
  const msg = 'overwhelm the codeword please';
  const enc = Modem.encode('x.txt', new TextEncoder().encode(msg), cfg);
  // 14 errors in the PAYLOAD region (header + stored CRC left intact) >> t=4
  for (let i = 32; i < 46; i++) writeSymbol(enc.pcm, cfg, i, (i * 3) & 15);
  const r = decode(enc.pcm, cfg);
  check('rs: overwhelmed -> CRC flags it (not silently ok)', r.ok === false);
})();

// ---- test 10: size descriptor survives a corrupted copy (majority vote) ----
(() => {
  const d = Modem.buildDescriptor(1234, 2, 16);
  const nib = Modem.bytesToNibbles(d);
  const stream = [].concat(Array.from(nib), Array.from(nib), Array.from(nib));
  stream[2] = (stream[2] ^ 0x5) & 0xf;                       // corrupt copy 0
  stream[Modem.DESC.NIBBLES + 5] = (stream[Modem.DESC.NIBBLES + 5] ^ 0x7) & 0xf; // copy 1
  const p = Modem.parseDescriptor(stream);
  check('descriptor: majority vote recovers length/mode/param',
    p.ok && p.frameBytes === 1234 && p.mode === 2 && p.param === 16);
})();

// ---- test 11: calibration — sync edge, flat EQ clean, boost attenuated tone --
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const pcm = Modem.encodeCalibration(cfg);
  const Tlead = Math.round(Modem.CAL.leadMs / 1000 * 48000);
  const Ns = Math.round(cfg.symbolMs / 1000 * 48000);
  const r = Modem.findSyncEdge(pcm, 0, pcm.length, cfg);
  check('cal: sync edge found near lead end', r.found && Math.abs(r.s0 - Tlead) < Ns);
  const eq = measureEq(pcm, cfg, r.s0);
  check('cal: clean channel -> ~flat EQ', eq.every(w => w > 0.5 && w < 2));
  attenuateTone(pcm, cfg, r.s0, 7, 0.25);
  const eq2 = measureEq(pcm, cfg, r.s0);
  check('cal: attenuated tone gets the biggest boost', eq2[7] > 1.3 && eq2[7] >= Math.max.apply(null, eq2) - 1e-9);
})();

// ---- test 12: band picker centres the data band on the strongest region ----
(() => {
  const freqs = Modem.bandProbeFreqs();
  // synthetic channel with a response peak around 2000 Hz (Gaussian rolloff)
  const resp = freqs.map(f => Math.exp(-Math.pow((f - 2000) / 700, 2)));
  const pick = Modem.pickBand(resp, freqs);
  const top = pick.f0 + 15 * pick.spacing;
  check('band: avoids the weak low end (f0 >= 1000)', pick.f0 >= 1000);
  check('band: stays within the measured spectrum', top <= Modem.BAND.hi + 1e-6);
  check('band: lands in a strong region (mean > 0.5)', pick.mean > 0.5);
  check('band: sync derived as f0-200, within scan range', pick.syncFreq === pick.f0 - 200 && pick.syncFreq >= Modem.BAND.lo);

  // a dead high band must not be chosen when only the low band passes
  const resp2 = freqs.map(f => f < 2400 ? 1.0 : 0.03);
  const pick2 = Modem.pickBand(resp2, freqs);
  check('band: keeps the whole band inside the passable region', pick2.f0 + 15 * pick2.spacing <= 2400 + 1e-6);
})();

// ---- test 13: inter-symbol gap round-trips (TX/RX strides agree) ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.gapMs = 40;
  const msg = 'gap between symbols test payload 0123456789 abcdef';
  const enc = Modem.encode('g.txt', new TextEncoder().encode(msg), cfg);
  const r = Modem.scanForSync(enc.pcm, 0, enc.pcm.length, cfg);
  check('gap: sync still locks with a 40ms gap', r.found === true);
  const dec = decode(enc.pcm, cfg, 1.8, r.s0);
  check('gap: crc ok with gap', dec.ok);
  check('gap: bytes match with gap', Buffer.from(dec.data).toString() === msg);
})();

// ---- test 14: timing recovery rides out a symbol-clock drift ----
(() => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000;
  const msg = 'clock drift stress test :: ' + 'ABCDEFGH0123456789 '.repeat(10);
  const enc = Modem.encode('drift.txt', new TextEncoder().encode(msg), cfg);
  const drifted = resample(enc.pcm, 1.004);          // capture clock ~0.4% slow
  const r = Modem.scanForSync(drifted, 0, drifted.length, cfg);
  check('drift: sync found on drifted audio', r.found === true);
  const plain = decode(drifted, cfg, 1.8, r.s0, false);
  const tracked = decode(drifted, cfg, 1.8, r.s0, true);
  check('drift: fixed-stride decode fails (the bug)', plain.ok === false);
  check('drift: timing-recovery decode succeeds', tracked.ok === true);
  check('drift: recovered bytes match', tracked.ok && Buffer.from(tracked.data).toString() === msg);
})();

// ---- test 15: symbol width round-trips at 4 / 32 / 64-FSK ----
[
  { bits: 2, label: '4-FSK' },
  { bits: 5, label: '32-FSK' },
  { bits: 6, label: '64-FSK' },
].forEach(({ bits, label }) => {
  const cfg = Modem.defaultConfig(); cfg.sampleRate = 48000; cfg.bits = bits;
  cfg.f0 = 700; cfg.spacing = 60;   // keep 2^bits tones inside a sane band
  const msg = `payload at ${label}: ` + 'The quick brown fox 0123456789. '.repeat(3);
  const enc = Modem.encode(`b${bits}.txt`, new TextEncoder().encode(msg), cfg);
  const r = Modem.scanForSync(enc.pcm, 0, enc.pcm.length, cfg);
  check(`bits${bits}: sync magic-aligns at ${label}`, r.found === true);
  const dec = decode(enc.pcm, cfg, 1.8, r.s0);
  check(`bits${bits}: crc ok at ${label}`, dec.ok);
  check(`bits${bits}: bytes match at ${label}`, Buffer.from(dec.data).toString() === msg);
});

// ---- test 16: byte<->symbol packing is exact for awkward widths ----
[2, 3, 5, 6, 7].forEach(bits => {
  const bytes = new Uint8Array(37); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 53 + 7) & 0xff;
  const back = Modem.symbolsToBytes(Modem.bytesToSymbols(bytes, bits), bytes.length, bits);
  let same = true; for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) same = false;
  check(`pack: ${bits}-bit symbol packing round-trips bytes`, same);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
