/* =============================================================================
 * SPIDERTEC SONIC TRANSFER PROTOCOL  ::  acoustic modem core
 * -----------------------------------------------------------------------------
 * 16-FSK modem. Each symbol carries one nibble (4 bits) as a pure tone.
 *   - SYNC lead-in tone (below the data band) marks transmission start and
 *     lets the receiver lock its symbol clock to the sync falling edge.
 *   - Frame: magic "SS" + version + flags + nameLen + name + dataLen + data + CRC32
 *   - XOR-FEC: optional parity nibbles (XOR per block) appended after the data.
 *     Enables single-erasure repair per block.
 *
 * Goertzel filters are used for both detection and demodulation: cheap, and we
 * only ever care about a handful of known frequencies.
 * ========================================================================== */

const Modem = (() => {
  'use strict';

  const MAGIC0 = 0x53; // 'S'
  const MAGIC1 = 0x53; // 'S'
  const VERSION = 0x01;

  // ---- CRC32 -----------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- Reed-Solomon over GF(256) (prim 0x11d, generator 2) -------------------
  // Corrects up to floor(nsym/2) *unknown* byte errors per codeword — unlike XOR
  // parity it does not need to know which symbols are bad. Faithful port of the
  // classic Berlekamp-Massey + Chien + Forney algorithm.
  const _GFEXP = new Uint8Array(512), _GFLOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { _GFEXP[i] = x; _GFLOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) _GFEXP[i] = _GFEXP[i - 255];
  })();
  const gMul = (a, b) => (a === 0 || b === 0) ? 0 : _GFEXP[_GFLOG[a] + _GFLOG[b]];
  const gDiv = (a, b) => (a === 0) ? 0 : _GFEXP[(_GFLOG[a] + 255 - _GFLOG[b]) % 255];
  const gInv = (a) => _GFEXP[255 - _GFLOG[a]];
  const gPow = (a, n) => _GFEXP[((_GFLOG[a] * n) % 255 + 255) % 255];

  function pScale(p, s) { const r = new Array(p.length); for (let i = 0; i < p.length; i++) r[i] = gMul(p[i], s); return r; }
  function pAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function pMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) if (q[j]) for (let i = 0; i < p.length; i++) r[i + j] ^= gMul(p[i], q[j]);
    return r;
  }
  function pEval(p, x) { let y = p[0]; for (let i = 1; i < p.length; i++) y = gMul(y, x) ^ p[i]; return y; }

  function rsGenPoly(nsym) { let g = [1]; for (let i = 0; i < nsym; i++) g = pMul(g, [1, gPow(2, i)]); return g; }

  function rsEncode(msg, nsym) {
    const gen = rsGenPoly(nsym);
    const out = new Array(msg.length + nsym).fill(0);
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= gMul(gen[j], c);
    }
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];   // restore systematic data
    return out;                                             // data || parity
  }

  function rsSynd(msg, nsym) { const s = new Array(nsym + 1).fill(0); for (let i = 0; i < nsym; i++) s[i + 1] = pEval(msg, gPow(2, i)); return s; }

  function rsErrLoc(synd, nsym) {
    let errLoc = [1], oldLoc = [1];
    const shift = synd.length - nsym;
    for (let i = 0; i < nsym; i++) {
      const K = i + shift;
      let delta = synd[K];
      for (let j = 1; j < errLoc.length; j++) delta ^= gMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = pScale(oldLoc, delta);
          oldLoc = pScale(errLoc, gInv(delta));
          errLoc = newLoc;
        }
        errLoc = pAdd(errLoc, pScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    if ((errLoc.length - 1) * 2 > nsym) throw new Error('rs: too many errors');
    return errLoc;
  }

  function rsFindErrors(errLocRev, nmess) {
    const errs = errLocRev.length - 1, pos = [];
    for (let i = 0; i < nmess; i++) if (pEval(errLocRev, gPow(2, i)) === 0) pos.push(nmess - 1 - i);
    if (pos.length !== errs) throw new Error('rs: cannot locate errors');
    return pos;
  }

  function rsErrataLoc(ePos) { let e = [1]; for (const i of ePos) e = pMul(e, pAdd([1], [gPow(2, i), 0])); return e; }
  function rsErrEval(synd, errLoc, nsym) { let r = pMul(synd, errLoc); return r.slice(r.length - (nsym + 1)); }

  function rsCorrect(msg, synd, errPos) {
    const coefPos = errPos.map(p => msg.length - 1 - p);
    const errLoc = rsErrataLoc(coefPos);
    const errEval = rsErrEval(synd.slice().reverse(), errLoc, errLoc.length - 1).slice().reverse();
    const X = [];
    for (let i = 0; i < coefPos.length; i++) X.push(gPow(2, -(255 - coefPos[i])));
    const E = new Array(msg.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const XiInv = gInv(X[i]);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = gMul(prime, 1 ^ gMul(XiInv, X[j]));
      let y = pEval(errEval.slice().reverse(), XiInv);
      y = gMul(gPow(X[i], 1), y);
      if (prime === 0) throw new Error('rs: zero denominator');
      E[errPos[i]] = gDiv(y, prime);
    }
    return pAdd(msg, E);
  }

  // Decode one codeword (data||parity). Returns { bytes, errs }; throws if it
  // cannot correct (more than floor(nsym/2) errors).
  function rsDecode(codeword, nsym) {
    let out = codeword.slice();
    let synd = rsSynd(out, nsym);
    if (Math.max.apply(null, synd) === 0) return { bytes: out, errs: 0 };
    const errLoc = rsErrLoc(synd, nsym);
    const errPos = rsFindErrors(errLoc.slice().reverse(), out.length);
    out = rsCorrect(out, synd, errPos);
    synd = rsSynd(out, nsym);
    if (Math.max.apply(null, synd) > 0) throw new Error('rs: decode failed');
    return { bytes: out, errs: errPos.length };
  }

  // Frame <-> RS codeword stream. Splits into <=255-byte systematic codewords,
  // `parity` (=nsym) parity bytes each.
  function rsEncodeStream(frame, parity) {
    const D = 255 - parity, out = [];
    for (let s = 0; s < frame.length; s += D) {
      const block = Array.prototype.slice.call(frame, s, Math.min(s + D, frame.length));
      const cw = rsEncode(block, parity);
      for (let i = 0; i < cw.length; i++) out.push(cw[i] & 0xff);
    }
    return Uint8Array.from(out);
  }
  function rsDecodeStream(stream, frameLen, parity) {
    const D = 255 - parity, nCw = Math.ceil(frameLen / D);
    const frame = []; let errs = 0, pos = 0;
    for (let c = 0; c < nCw; c++) {
      const dlen = Math.min(D, frameLen - c * D);
      const cw = Array.prototype.slice.call(stream, pos, pos + dlen + parity); pos += dlen + parity;
      let bytes = cw;
      try { const dec = rsDecode(cw, parity); bytes = dec.bytes; errs += dec.errs; }
      catch (e) { errs = -1; }     // uncorrectable; keep raw, CRC will flag it
      for (let i = 0; i < dlen; i++) frame.push(bytes[i] & 0xff);
    }
    return { frame: Uint8Array.from(frame), errs };
  }

  const EC = { NONE: 0, XOR: 1, RS: 2 };
  const ecModeNum = (m) => m === 'rs' ? EC.RS : m === 'xor' ? EC.XOR : EC.NONE;

  // How a frame of `frameBytes` expands on the wire for a given EC mode/param.
  // `bits` = bits per symbol (tone). dataNibbles is kept as the field name but now
  // means "data symbols" (= nibbles only when bits === 4).
  function ecPlan(frameBytes, mode, param, bits) {
    bits = bits || 4;
    const symsFor = (nbytes) => Math.ceil(nbytes * 8 / bits);
    const frameSymbols = symsFor(frameBytes);
    if (mode === EC.XOR) {
      const parity = Math.ceil(frameSymbols / param);
      return { dataNibbles: frameSymbols, totalSymbols: frameSymbols + parity, parity };
    }
    if (mode === EC.RS) {
      const D = 255 - param, nCw = Math.ceil(frameBytes / D);
      const streamSymbols = symsFor(frameBytes + nCw * param);
      return { dataNibbles: streamSymbols, totalSymbols: streamSymbols, parity: streamSymbols - frameSymbols };
    }
    return { dataNibbles: frameSymbols, totalSymbols: frameSymbols, parity: 0 };
  }

  function nibblesToBytesArr(nibbles, byteCount) {
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) out[i] = ((nibbles[i * 2] & 0xf) << 4) | (nibbles[i * 2 + 1] & 0xf);
    return out;
  }

  const numTones = (cfg) => 1 << ((cfg && cfg.bits) || 4);

  // ---- generic B-bit symbol <-> byte packing (MSB-first bitstream) -----------
  // Generalises nibble packing to any symbol width. A B-bit symbol carries B bits
  // of the byte stream; the last symbol of a frame is zero-padded.
  function bytesToSymbols(bytes, bits) {
    bits = bits || 4;
    const mask = (1 << bits) - 1, out = [];
    let acc = 0, nbits = 0;
    for (let i = 0; i < bytes.length; i++) {
      acc = ((acc << 8) | bytes[i]) >>> 0;
      nbits += 8;
      while (nbits >= bits) { nbits -= bits; out.push((acc >>> nbits) & mask); }
      acc &= (1 << nbits) - 1;                  // keep only the residual bits
    }
    if (nbits > 0) out.push((acc << (bits - nbits)) & mask);   // pad final symbol
    return out;
  }
  function symbolsToBytes(symbols, byteCount, bits) {
    bits = bits || 4;
    const mask = (1 << bits) - 1, out = new Uint8Array(byteCount);
    let acc = 0, nbits = 0, oi = 0;
    for (let i = 0; i < symbols.length && oi < byteCount; i++) {
      acc = ((acc << bits) | (symbols[i] & mask)) >>> 0;
      nbits += bits;
      while (nbits >= 8 && oi < byteCount) { nbits -= 8; out[oi++] = (acc >>> nbits) & 0xff; }
      acc &= (1 << nbits) - 1;
    }
    return out;
  }

  // Rebuild the frame bytes from received symbols, applying the chosen EC.
  // Returns { frame:Uint8Array, repaired } (repaired<0 => uncorrectable for RS).
  function ecReconstruct(symbols, confs, frameBytes, mode, param, erasureThresh, bits) {
    bits = bits || 4;
    if (mode === EC.XOR) {
      const dataSymbols = Math.ceil(frameBytes * 8 / bits);
      const paritySyms = symbols.slice(dataSymbols);
      let repaired = 0;
      for (let blk = 0; blk < paritySyms.length; blk++) {
        const start = blk * param, end = Math.min(start + param, dataSymbols);
        let xor = 0; const erasures = [];
        for (let i = start; i < end; i++) { xor ^= symbols[i]; if (confs[i] < erasureThresh) erasures.push(i); }
        if (xor !== paritySyms[blk] && erasures.length === 1) { symbols[erasures[0]] ^= (xor ^ paritySyms[blk]); repaired++; }
      }
      return { frame: symbolsToBytes(symbols, frameBytes, bits), repaired };
    }
    if (mode === EC.RS) {
      const D = 255 - param, nCw = Math.ceil(frameBytes / D);
      const streamBytes = frameBytes + nCw * param;
      const sb = symbolsToBytes(symbols, streamBytes, bits);
      return ((r) => ({ frame: r.frame, repaired: r.errs }))(rsDecodeStream(sb, frameBytes, param));
    }
    return { frame: symbolsToBytes(symbols, frameBytes, bits), repaired: 0 };
  }

  // ---- size descriptor -------------------------------------------------------
  // A tiny, fixed-size announcement sent (repeated 3x) right after the sync tone,
  // BEFORE the payload: it tells the receiver exactly how many symbols to expect.
  // Majority-voted per nibble + CRC8, so the receiver reliably learns the length
  // even if the main frame's own header is noisy.
  const DESC = { REPEAT: 3, BYTES: 9 };
  DESC.NIBBLES = DESC.BYTES * 2;          // 18  (bits === 4)
  DESC.SYMBOLS = DESC.NIBBLES * DESC.REPEAT; // 54  (bits === 4)
  // symbols the descriptor occupies for a given symbol width (per copy / total)
  const descPerCopy = (bits) => Math.ceil(DESC.BYTES * 8 / (bits || 4));
  const descSymbols = (bits) => descPerCopy(bits) * DESC.REPEAT;

  function crc8(bytes, n) {
    let c = 0;
    for (let i = 0; i < n; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c & 0xff;
  }

  function buildDescriptor(frameBytes, mode, param) {
    const d = new Uint8Array(DESC.BYTES);
    d[0] = MAGIC0; d[1] = MAGIC1;
    d[2] = (frameBytes >>> 24) & 0xff; d[3] = (frameBytes >>> 16) & 0xff;
    d[4] = (frameBytes >>> 8) & 0xff; d[5] = frameBytes & 0xff;
    d[6] = mode & 0xff; d[7] = param & 0xff;
    d[8] = crc8(d, 8);
    return d;
  }

  // symbols: at least descSymbols(bits) received symbols. Majority-vote the 3 copies.
  function parseDescriptor(symbols, bits) {
    bits = bits || 4;
    const per = descPerCopy(bits);
    const voted = new Array(per);
    for (let p = 0; p < per; p++) {
      const a = symbols[p], b = symbols[p + per], c = symbols[p + 2 * per];
      voted[p] = (a === b || a === c) ? a : (b === c) ? b : a;   // majority, else first copy
    }
    const d = symbolsToBytes(voted, DESC.BYTES, bits);
    const ok = d[0] === MAGIC0 && d[1] === MAGIC1 && crc8(d, 8) === d[8];
    const frameBytes = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
    return { ok, frameBytes, mode: d[6], param: d[7] };
  }

  // ---- defaults --------------------------------------------------------------
  function defaultConfig() {
    return {
      sampleRate: 48000,   // overwritten by the live AudioContext
      f0: 1200,            // first data tone (Hz)
      spacing: 100,        // spacing between the 16 data tones (Hz)
      symbolMs: 60,        // duration of one symbol
      bits: 4,             // bits per symbol -> 2^bits FSK tones (must match both sides)
      gapMs: 0,            // silent guard gap inserted between symbols (0 = back-to-back)
      syncFreq: 1000,      // sync lead-in tone (below data band)
      syncMs: 600,         // sync lead-in duration (long = easy to catch)
      volume: 0.32,        // 0..1
      ecMode: 'rs',        // 'none' | 'xor' (XOR parity) | 'rs' (Reed-Solomon)
      fecBlock: 16,        // XOR: nibbles per parity block
      rsParity: 16,        // RS: parity bytes per codeword (corrects rsParity/2 errors)
      trackRange: 0.4,     // RX timing recovery: per-symbol search range as a fraction of Ns (0 = off)
      trackGain: 0.5       // RX timing recovery: clock-tracking feedback gain (0..1)
    };
  }

  const dataFreq = (cfg, sym) => cfg.f0 + sym * cfg.spacing;

  // =========================================================================
  //  ENCODER
  // =========================================================================

  // Build the framed byte array from a payload.
  function buildFrame(name, data, cfg) {
    const nameBytes = new TextEncoder().encode(name).slice(0, 255);
    const dataLen = data.length;

    const mode = ecModeNum(cfg.ecMode);
    const param = mode === EC.RS ? (cfg.rsParity & 0xff)
      : mode === EC.XOR ? (cfg.fecBlock & 0xff) : 0;

    const header = [];
    header.push(MAGIC0, MAGIC1, VERSION);
    header.push(mode);                      // EC mode: 0 none / 1 XOR / 2 RS
    header.push(param);                     // EC parameter (block size or parity bytes)
    header.push(nameBytes.length);
    for (const b of nameBytes) header.push(b);
    header.push((dataLen >>> 24) & 0xff, (dataLen >>> 16) & 0xff,
                (dataLen >>> 8) & 0xff, dataLen & 0xff);

    const body = new Uint8Array(header.length + dataLen + 4);
    body.set(header, 0);
    body.set(data, header.length);

    // CRC32 over everything before the CRC field itself.
    const crc = crc32(body.subarray(0, header.length + dataLen));
    const off = header.length + dataLen;
    body[off] = (crc >>> 24) & 0xff;
    body[off + 1] = (crc >>> 16) & 0xff;
    body[off + 2] = (crc >>> 8) & 0xff;
    body[off + 3] = crc & 0xff;
    return body;
  }

  function bytesToNibbles(bytes) {
    const n = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
      n[i * 2] = (bytes[i] >> 4) & 0x0f;
      n[i * 2 + 1] = bytes[i] & 0x0f;
    }
    return n;
  }

  // XOR-parity symbols, one per block (mask to the symbol width).
  function parityNibbles(symbols, block, bits) {
    const mask = (1 << (bits || 4)) - 1, out = [];
    for (let i = 0; i < symbols.length; i += block) {
      let p = 0;
      for (let j = i; j < Math.min(i + block, symbols.length); j++) p ^= symbols[j];
      out.push(p & mask);
    }
    return out;
  }

  // Produce a Float32Array of PCM and a per-symbol descriptor list.
  // Returns { pcm, symbols:[{sym}], dataNibbleCount, parityCount }
  function encode(name, data, cfg) {
    const sr = cfg.sampleRate;
    const Ns = Math.round((cfg.symbolMs / 1000) * sr);
    const Ng = Math.round(((cfg.gapMs || 0) / 1000) * sr);            // silent gap between symbols
    const Nsync = Math.round((cfg.syncMs / 1000) * sr);
    const fade = Math.min(Math.round(0.004 * sr), Math.floor(Ns / 4)); // anti-click

    const bits = cfg.bits || 4;
    const frame = buildFrame(name, data, cfg);
    const mode = ecModeNum(cfg.ecMode);
    const param = mode === EC.RS ? cfg.rsParity : mode === EC.XOR ? cfg.fecBlock : 0;

    const symbols = [];
    // size descriptor (repeated) leads the payload so the receiver knows the length
    const descSyms = bytesToSymbols(buildDescriptor(frame.length, mode, param), bits);
    for (let r = 0; r < DESC.REPEAT; r++)
      for (let i = 0; i < descSyms.length; i++) symbols.push({ sym: descSyms[i] });

    let dataNibbleCount, parityCount = 0;
    if (mode === EC.XOR) {
      const dn = bytesToSymbols(frame, bits);
      dataNibbleCount = dn.length;
      for (let i = 0; i < dn.length; i++) symbols.push({ sym: dn[i] });
      const parity = parityNibbles(dn, cfg.fecBlock, bits);
      parityCount = parity.length;
      for (let i = 0; i < parity.length; i++) symbols.push({ sym: parity[i] });
    } else {
      const stream = mode === EC.RS ? rsEncodeStream(frame, cfg.rsParity) : frame;
      const dn = bytesToSymbols(stream, bits);
      dataNibbleCount = dn.length;
      parityCount = mode === EC.RS ? (dn.length - bytesToSymbols(frame, bits).length) : 0;
      for (let i = 0; i < dn.length; i++) symbols.push({ sym: dn[i] });
    }

    const total = Nsync + symbols.length * (Ns + Ng);
    const pcm = new Float32Array(total);

    // -- sync lead-in --
    let phase = 0;
    const wSync = 2 * Math.PI * cfg.syncFreq / sr;
    for (let i = 0; i < Nsync; i++) {
      let env = 1;
      if (i < fade) env = i / fade;
      else if (i > Nsync - fade) env = (Nsync - i) / fade;
      pcm[i] = Math.sin(phase) * cfg.volume * env;
      phase += wSync;
    }

    // -- data + parity symbols (continuous phase per symbol, optional silent gap) --
    let p = Nsync;
    for (const s of symbols) {
      const f = dataFreq(cfg, s.sym);
      const w = 2 * Math.PI * f / sr;
      let ph = 0;
      for (let i = 0; i < Ns; i++) {
        let env = 1;
        if (i < fade) env = i / fade;
        else if (i > Ns - fade) env = (Ns - i) / fade;
        pcm[p + i] = Math.sin(ph) * cfg.volume * env;
        ph += w;
      }
      p += Ns + Ng;          // leave Ng samples of silence between symbols
    }

    // soft clip
    for (let i = 0; i < pcm.length; i++) {
      if (pcm[i] > 1) pcm[i] = 1; else if (pcm[i] < -1) pcm[i] = -1;
    }

    return {
      pcm,
      symbols,
      dataNibbleCount,
      parityCount,
      frameBytes: frame.length,
      Ns, Ng, Nsync
    };
  }

  // =========================================================================
  //  GOERTZEL
  // =========================================================================
  function goertzel(buf, start, len, freq, sr) {
    const w = 2 * Math.PI * freq / sr;
    const coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    const begin = start < 0 ? 0 : start;       // clamp: out-of-range reads -> silence
    const end = Math.min(start + len, buf.length);
    for (let n = begin; n < end; n++) {
      const s0 = buf[n] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  // Energy + spectral concentration of one window at a target frequency.
  function concentration(buf, start, len, freq, sr) {
    const e = goertzel(buf, start, len, freq, sr);
    let ss = 0; const end = start + len;
    for (let i = start; i < end; i++) ss += buf[i] * buf[i];
    return { e, conc: ss > 1e-9 ? e / ss : 0, ss };
  }

  const SYNC_PRESENCE = 0.06;   // min concentration to call the sync tone "present"
  const SYNC_MIN_SYM = 3;       // min sustained sync, in symbol-durations, to lock

  // Find the data-start offset s0 by trying candidate alignments around the
  // detected sync edge and keeping the one where the frame magic ("SS" =
  // nibbles 5,3,5,3) actually decodes. Far more robust than guessing the edge:
  // tolerates reverb tails, fades and clock offset. Returns -1 if none read.
  function alignByMagic(buf, coarseEnd, len, cfg) {
    const sr = cfg.sampleRate;
    const bits = cfg.bits || 4;
    const Ns = Math.round(cfg.symbolMs / 1000 * sr);
    const S = Ns + Math.round(((cfg.gapMs || 0) / 1000) * sr);   // symbol stride incl. gap
    const lo = Math.max(0, coarseEnd - Ns);
    const hi = coarseEnd + Ns;
    const stepA = Math.max(1, Math.floor(Ns / 12));
    // leading symbols of the descriptor that are fully determined by the constant
    // magic bytes "SS" (0x53,0x53) — i.e. symbols within the first 16 bits.
    const want = bytesToSymbols(Uint8Array.from([MAGIC0, MAGIC1]), bits).slice(0, Math.max(1, Math.floor(16 / bits)));
    const matches = [];
    for (let s0 = lo; s0 <= hi; s0 += stepA) {
      if (s0 + want.length * S + Math.floor(Ns * 0.5) >= len) break;
      let ok = true;
      for (let k = 0; k < want.length; k++) {
        const d = demodSymbol(buf, s0 + k * S + Math.floor(Ns / 2), cfg);
        if (d.sym !== want[k]) { ok = false; break; }
      }
      if (ok) matches.push(s0);
    }
    if (!matches.length) return -1;
    // center of the contiguous matching band → least drift over the frame
    return matches[Math.floor(matches.length / 2)];
  }

  // Scan [from, len) for a sync lead-in, then magic-align the data start.
  //   { found:true,  s0, nextScan, sensing:true }   frame magic confirmed
  //   { found:false, nextScan, sensing }            sensing=true => a tone is
  //       present / being validated (preserve position for the next chunk)
  function scanForSync(buf, from, len, cfg) {
    const sr = cfg.sampleRate;
    const Ns = Math.round(cfg.symbolMs / 1000 * sr);
    const S = Ns + Math.round(((cfg.gapMs || 0) / 1000) * sr);   // symbol stride incl. gap
    const step = Math.max(1, Math.floor(Ns / 4));
    let inSync = false, syncStart = 0;
    for (let pos = from; pos + Ns <= len; pos += step) {
      const c = concentration(buf, pos, Ns, cfg.syncFreq, sr);
      const present = c.conc > Ns * SYNC_PRESENCE && c.ss > 1e-6;
      if (present) {
        if (!inSync) { inSync = true; syncStart = pos; }
      } else if (inSync) {
        if (pos - syncStart >= Ns * SYNC_MIN_SYM) {
          // need enough buffered data past the edge to validate the magic
          if (len < pos + 4 * S + 2 * Ns) return { found: false, nextScan: syncStart, sensing: true };
          const s0 = alignByMagic(buf, pos, len, cfg);
          if (s0 >= 0) return { found: true, s0, nextScan: pos, sensing: true };
          // heard a tone but no readable frame here — skip past it
        }
        inSync = false;
      }
    }
    const nextScan = inSync ? syncStart : Math.max(from, len - Ns * 2);
    return { found: false, nextScan, sensing: inSync };
  }

  // Find just the sync lead-in falling edge (no magic alignment). Used by the
  // calibration sequence, which has a fixed tone sweep (not a frame) after sync.
  function findSyncEdge(buf, from, len, cfg) {
    const sr = cfg.sampleRate;
    const Ns = Math.round(cfg.symbolMs / 1000 * sr);
    const step = Math.max(1, Math.floor(Ns / 4));
    let inSync = false, syncStart = 0;
    for (let pos = from; pos + Ns <= len; pos += step) {
      const c = concentration(buf, pos, Ns, cfg.syncFreq, sr);
      const present = c.conc > Ns * SYNC_PRESENCE && c.ss > 1e-6;
      if (present) { if (!inSync) { inSync = true; syncStart = pos; } }
      else if (inSync) {
        if (pos - syncStart >= Ns * SYNC_MIN_SYM) return { found: true, s0: pos, nextScan: pos, sensing: true };
        inSync = false;
      }
    }
    return { found: false, nextScan: inSync ? syncStart : Math.max(from, len - Ns * 2), sensing: inSync };
  }

  // ---- calibration sequence --------------------------------------------------
  // sync lead-in, then each of the 2^bits data tones swept REPEATS times. The
  // receiver measures per-tone level to build an equaliser and set input gain.
  const CAL = { leadMs: 600, toneMs: 120, repeats: 3 };

  function encodeCalibration(cfg) {
    const sr = cfg.sampleRate;
    const M = numTones(cfg);
    const Tlead = Math.round(CAL.leadMs / 1000 * sr);
    const Tcal = Math.round(CAL.toneMs / 1000 * sr);
    const fade = Math.min(Math.round(0.004 * sr), Math.floor(Tcal / 4));
    const slots = CAL.repeats * M;
    const pcm = new Float32Array(Tlead + slots * Tcal);
    let ph = 0; const wS = 2 * Math.PI * cfg.syncFreq / sr;
    for (let i = 0; i < Tlead; i++) {
      let env = 1;
      if (i < fade) env = i / fade; else if (i > Tlead - fade) env = (Tlead - i) / fade;
      pcm[i] = Math.sin(ph) * cfg.volume * env; ph += wS;
    }
    let p = Tlead;
    for (let j = 0; j < slots; j++) {
      const f = dataFreq(cfg, j % M), w = 2 * Math.PI * f / sr; let tp = 0;
      for (let i = 0; i < Tcal; i++) {
        let env = 1;
        if (i < fade) env = i / fade; else if (i > Tcal - fade) env = (Tcal - i) / fade;
        pcm[p + i] = Math.sin(tp) * cfg.volume * env; tp += w;
      }
      p += Tcal;
    }
    return pcm;
  }

  // ---- full-spectrum band scan -----------------------------------------------
  // A wide sweep used to discover which part of the spectrum the channel passes
  // best, so the operator can move the data band there. Independent of the
  // current f0/spacing: it probes a fixed grid of frequencies and uses its own
  // fixed lead-in tone (so the receiver can find the sweep regardless of the
  // band that's currently configured on either side).
  const BAND = { leadMs: 700, lo: 400, hi: 4800, step: 120, toneMs: 90, repeats: 2, syncFreq: 800 };

  function bandProbeFreqs() {
    const f = [];
    for (let x = BAND.lo; x <= BAND.hi + 1e-6; x += BAND.step) f.push(x);
    return f;
  }

  function encodeBandScan(cfg) {
    const sr = cfg.sampleRate;
    const Tlead = Math.round(BAND.leadMs / 1000 * sr);
    const Tt = Math.round(BAND.toneMs / 1000 * sr);
    const fade = Math.min(Math.round(0.004 * sr), Math.floor(Tt / 4));
    const freqs = bandProbeFreqs();
    const slots = BAND.repeats * freqs.length;
    const pcm = new Float32Array(Tlead + slots * Tt);
    let ph = 0; const wS = 2 * Math.PI * BAND.syncFreq / sr;
    for (let i = 0; i < Tlead; i++) {
      let env = 1;
      if (i < fade) env = i / fade; else if (i > Tlead - fade) env = (Tlead - i) / fade;
      pcm[i] = Math.sin(ph) * cfg.volume * env; ph += wS;
    }
    let p = Tlead;
    for (let j = 0; j < slots; j++) {
      const f = freqs[j % freqs.length], w = 2 * Math.PI * f / sr; let tp = 0;
      for (let i = 0; i < Tt; i++) {
        let env = 1;
        if (i < fade) env = i / fade; else if (i > Tt - fade) env = (Tt - i) / fade;
        pcm[p + i] = Math.sin(tp) * cfg.volume * env; tp += w;
      }
      p += Tt;
    }
    return pcm;
  }

  // Linear interpolation of an evenly-spaced response curve at frequency `f`.
  function _bandInterp(freqs, resp, f) {
    if (f <= freqs[0]) return resp[0];
    if (f >= freqs[freqs.length - 1]) return resp[resp.length - 1];
    const idx = (f - freqs[0]) / (freqs[1] - freqs[0]);
    const i0 = Math.floor(idx), t = idx - i0;
    return resp[i0] * (1 - t) + resp[i0 + 1] * t;
  }

  // Given the measured per-probe energy `resp`, pick the slider-legal (f0, spacing)
  // whose 16 data tones + sync marker land where the channel responds best.
  // Favours a high mean level, a strong *worst* tone (flatness) and a usable sync
  // tone. syncFreq is derived as f0-200 (matches the default 1200/1000 relation),
  // so relaying just BASE FREQ + TONE SPACING to the transmitter is enough.
  function pickBand(resp, freqs, bits) {
    const M = 1 << (bits || 4);
    const maxR = Math.max.apply(null, resp) || 1;
    const norm = resp.map(r => r / maxR);
    let best = null;
    for (let f0 = 600; f0 <= 2000; f0 += 50) {
      const sync = f0 - 200;
      if (sync < BAND.lo) continue;
      for (let sp = 60; sp <= 200; sp += 10) {
        const top = f0 + (M - 1) * sp;
        if (top > BAND.hi) continue;
        let sum = 0, min = Infinity;
        for (let k = 0; k < M; k++) {
          const v = _bandInterp(freqs, norm, f0 + k * sp);
          sum += v; if (v < min) min = v;
        }
        const mean = sum / M;
        const syncV = _bandInterp(freqs, norm, sync);
        const dataScore = mean * (0.25 + 0.75 * min);   // high & flat
        const score = dataScore * (0.4 + 0.6 * syncV);  // sync matters, doesn't dominate
        if (!best || score > best.score) best = { f0, spacing: sp, syncFreq: sync, score, mean, min, syncV };
      }
    }
    if (!best) best = { f0: 600, spacing: 60, syncFreq: 400, score: 0, mean: 0, min: 0, syncV: 0 }; // fallback: band too wide to fit
    const toneE = [];
    for (let k = 0; k < M; k++) toneE.push(_bandInterp(freqs, resp, best.f0 + k * best.spacing));
    best.toneE = toneE;
    return best;
  }

  // Demodulate one symbol window -> { sym, conf }. Optional per-tone `eq`
  // weights (from calibration) compensate the channel's frequency response.
  function demodSymbol(buf, center, cfg, eq) {
    const sr = cfg.sampleRate;
    const Ns = Math.round((cfg.symbolMs / 1000) * sr);
    const use = Math.floor(Ns * 0.7);
    const start = Math.max(0, center - Math.floor(use / 2));
    const M = numTones(cfg);
    let best = -1, bestE = -1, secondE = 0;
    for (let s = 0; s < M; s++) {
      let e = goertzel(buf, start, use, dataFreq(cfg, s), sr);
      if (eq) e *= eq[s];
      if (e > bestE) { secondE = bestE; bestE = e; best = s; }
      else if (e > secondE) secondE = e;
    }
    const conf = secondE > 0 ? bestE / secondE : 99;
    return { sym: best, conf, energy: bestE };
  }

  // Demodulate around an expected center, but first nudge the window to the local
  // energy peak within ±maxJit samples. Returns { sym, conf, energy, offset } where
  // `offset` is the chosen nudge — feed a fraction of it back into the symbol clock
  // to TRACK slow speaker/mic sample-rate drift instead of letting it accumulate
  // across a long frame (which slides the window off the tone and garbles decode).
  function demodSymbolAligned(buf, center, cfg, eq, maxJit) {
    if (!maxJit || maxJit < 1) { const d = demodSymbol(buf, center, cfg, eq); d.offset = 0; return d; }
    const sr = cfg.sampleRate;
    const Ns = Math.round((cfg.symbolMs / 1000) * sr);
    const step = Math.max(1, Math.floor(Ns / 24));
    let best = null;
    for (let o = -maxJit; o <= maxJit; o += step) {
      const d = demodSymbol(buf, center + o, cfg, eq);
      if (!best || d.energy > best.energy) { d.offset = o; best = d; }
    }
    return best;
  }

  return {
    defaultConfig, crc32, encode, goertzel, demodSymbol, demodSymbolAligned,
    dataFreq, numTones, bytesToNibbles, bytesToSymbols, symbolsToBytes, parityNibbles, buildFrame,
    concentration, scanForSync, alignByMagic, findSyncEdge,
    rsEncode, rsDecode, rsEncodeStream, rsDecodeStream,
    ecPlan, ecReconstruct, ecModeNum, EC,
    DESC, descSymbols, buildDescriptor, parseDescriptor, crc8,
    CAL, encodeCalibration,
    BAND, bandProbeFreqs, encodeBandScan, pickBand,
    MAGIC0, MAGIC1
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Modem;
