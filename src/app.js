/* =============================================================================
 * SPIDERTEC SONIC TRANSFER PROTOCOL :: renderer / UI / audio engine
 * ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cfg = Modem.defaultConfig();

  // ---------------------------------------------------------------- audio core
  let ctx = null;
  let vizAnalyser = null;            // shared analyser for both scopes
  let rafId = null;
  let currentPayload = null;         // { name, bytes:Uint8Array }
  let lastEncoded = null;            // { pcm } for WAV export
  let txSource = null;

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      cfg.sampleRate = ctx.sampleRate;
      vizAnalyser = ctx.createAnalyser();
      vizAnalyser.fftSize = 2048;
      vizAnalyser.smoothingTimeConstant = 0.5;
      // silent sink keeps the analyser in the render graph WITHOUT routing any
      // audio to the speakers — so mic monitoring never feeds back.
      const vizSink = ctx.createGain();
      vizSink.gain.value = 0;
      vizAnalyser.connect(vizSink);
      vizSink.connect(ctx.destination);
      startViz();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ----------------------------------------------------------------------- log
  const logEl = $('log');
  function log(msg, cls = 'info') {
    const t = new Date().toLocaleTimeString('en-GB');
    const div = document.createElement('div');
    div.innerHTML = `<span class="l-time">[${t}]</span> <span class="l-${cls}">${msg}</span>`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
  }

  // -------------------------------------------------------------- mode / clock
  const modeLed = $('modeLed'), modeTxt = $('modeTxt');
  function setMode(state) {
    modeLed.className = 'led';
    if (state === 'TRANSMIT') { modeLed.classList.add('on'); modeTxt.textContent = 'TRANSMITTING'; }
    else if (state === 'RECEIVE') { modeLed.classList.add('rx'); modeTxt.textContent = 'LISTENING'; }
    else if (state === 'ERR') { modeLed.classList.add('err'); modeTxt.textContent = 'ERROR'; }
    else { modeTxt.textContent = 'IDLE'; }
  }
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);

  // ----------------------------------------------------------------- tab logic
  function showSend() {
    $('tabSend').classList.add('active'); $('tabRecv').classList.remove('active');
    $('sendView').hidden = false; $('recvView').hidden = true;
  }
  function showRecv() {
    $('tabRecv').classList.add('active'); $('tabSend').classList.remove('active');
    $('recvView').hidden = false; $('sendView').hidden = true;
  }
  $('tabSend').onclick = showSend;
  $('tabRecv').onclick = showRecv;

  // ------------------------------------------------------------- send controls
  function bindRange(rangeId, outId, fmt, onChange) {
    const r = $(rangeId), o = $(outId);
    const upd = () => { o.textContent = fmt(+r.value); onChange && onChange(+r.value); };
    r.addEventListener('input', upd); upd();
  }
  function refreshBandTxt() {
    const hi = cfg.f0 + 15 * cfg.spacing;
    $('bandTxt').textContent = `${cfg.f0}–${hi} Hz`;
    $('syncTxt').textContent = `${cfg.syncFreq} Hz`;
    $('fecTxt').textContent = cfg.ecMode === 'rs' ? 'REED–SOLOMON'
      : cfg.ecMode === 'xor' ? 'XOR' : 'OFF';
    updateEstimate();
  }
  bindRange('symRange', 'symOut', v => v + ' ms', v => { cfg.symbolMs = v; updateEstimate(); });
  bindRange('gapRange', 'gapOut', v => v + ' ms', v => { cfg.gapMs = v; updateEstimate(); });
  bindRange('f0Range', 'f0Out', v => v + ' Hz', v => { cfg.f0 = v; cfg.syncFreq = v - 200; refreshBandTxt(); });
  bindRange('spRange', 'spOut', v => v + ' Hz', v => { cfg.spacing = v; refreshBandTxt(); });
  bindRange('volRange', 'volOut', v => v + '%', v => { cfg.volume = v / 100; });

  // error-correction mode + contextual strength slider
  function updateEcUI() {
    const r = $('densRange');
    r.disabled = (cfg.ecMode === 'none');
    if (cfg.ecMode === 'rs') {
      r.value = cfg.rsParity;
      $('ecStrName').textContent = 'RS PARITY';
      $('densOut').textContent = `${cfg.rsParity} B (±${cfg.rsParity >> 1})`;
    } else if (cfg.ecMode === 'xor') {
      r.value = cfg.fecBlock;
      $('ecStrName').textContent = 'REPAIR DENSITY';
      $('densOut').textContent = `1:${cfg.fecBlock} (~${Math.round(100 / cfg.fecBlock)}%)`;
    } else {
      $('ecStrName').textContent = 'CORRECTION OFF';
      $('densOut').textContent = '—';
    }
  }
  $('ecMode').addEventListener('change', e => { cfg.ecMode = e.target.value; updateEcUI(); refreshBandTxt(); });
  $('bitsSel').addEventListener('change', e => { cfg.bits = +e.target.value; refreshBandTxt(); updateEstimate(); });
  $('densRange').addEventListener('input', () => {
    const v = +$('densRange').value;
    if (cfg.ecMode === 'rs') cfg.rsParity = v; else if (cfg.ecMode === 'xor') cfg.fecBlock = v;
    updateEcUI(); updateEstimate();
  });

  // file selection
  $('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    currentPayload = { name: f.name, bytes: buf };
    $('fileLabel').textContent = f.name.toUpperCase();
    $('fileMeta').textContent = `${buf.length} bytes  ::  ${f.type || 'application/octet-stream'}`;
    $('btnTransmit').disabled = false;
    log(`Payload loaded: ${f.name} (${buf.length} B)`, 'ok');
    updateEstimate();
  });

  function ecParam() {
    const m = Modem.ecModeNum(cfg.ecMode);
    return m === 2 ? cfg.rsParity : m === 1 ? cfg.fecBlock : 0;
  }
  function frameSymbolCount() {
    if (!currentPayload) return null;
    const nameLen = Math.min(new TextEncoder().encode(currentPayload.name).length, 255);
    const frameBytes = 6 + nameLen + 4 + currentPayload.bytes.length + 4;
    const plan = Modem.ecPlan(frameBytes, Modem.ecModeNum(cfg.ecMode), ecParam(), cfg.bits);
    return { dataNibbles: plan.dataNibbles, parity: plan.parity, symbols: plan.totalSymbols };
  }
  function updateEstimate() {
    const c = frameSymbolCount();
    if (!c) { $('estimate').textContent = 'awaiting payload…'; return; }
    const secs = (cfg.syncMs + c.symbols * (cfg.symbolMs + cfg.gapMs)) / 1000;
    const bps = (currentPayload.bytes.length * 8) / secs;
    $('estimate').textContent =
      `≈ ${secs.toFixed(1)} s  ::  ${c.symbols} symbols ` +
      `(${c.parity} repair)  ::  ${bps.toFixed(0)} bit/s`;
  }

  // ----------------------------------------------------------------- TRANSMIT
  function transmit(name, bytes, isTest) {
    ensureCtx();
    setMode('TRANSMIT');
    log(isTest ? '=== TRANSMITTING TEST SIGNAL ===' : '=== INITIATING SONIC TRANSFER ===', 'warn');
    log(`Carrier band ${cfg.f0}-${cfg.f0 + 15 * cfg.spacing} Hz, ${cfg.symbolMs}ms/sym`, 'info');

    const enc = Modem.encode(name, bytes, cfg);
    lastEncoded = enc;
    log(`Frame ${enc.frameBytes} B → ${enc.symbols.length} symbols`, 'info');
    if (cfg.ecMode === 'xor') log(`Appending ${enc.parityCount} XOR-FEC parity packets`, 'info');
    else if (cfg.ecMode === 'rs') log(`Reed-Solomon: +${enc.parityCount} parity bytes (fixes ${cfg.rsParity >> 1}/codeword)`, 'info');

    const buffer = ctx.createBuffer(1, enc.pcm.length, ctx.sampleRate);
    buffer.copyToChannel(enc.pcm, 0);

    txSource = ctx.createBufferSource();
    txSource.buffer = buffer;
    txSource.connect(vizAnalyser);              // tap for the scopes
    txSource.connect(ctx.destination);          // play (analyser never feeds output)

    $('btnTransmit').disabled = true;
    $('btnTest').disabled = true;
    $('btnWav').disabled = false;
    $('btnStopTx').disabled = false;

    const dur = enc.pcm.length / ctx.sampleRate;
    const t0 = ctx.currentTime;
    txSource.start();
    log(`Broadcasting… hold the line for ${dur.toFixed(1)}s`, 'ok');

    const tick = setInterval(() => {
      const p = Math.min(100, ((ctx.currentTime - t0) / dur) * 100);
      $('sigBar').style.width = p + '%';
      if (p >= 100) clearInterval(tick);
    }, 80);

    txSource.onended = () => {
      clearInterval(tick);
      $('sigBar').style.width = '0%';
      $('btnTransmit').disabled = !currentPayload;
      $('btnTest').disabled = false;
      $('btnStopTx').disabled = true;
      setMode('IDLE');
      log('=== TRANSFER COMPLETE ===', 'ok');
    };
  }

  $('btnTransmit').addEventListener('click', () => {
    if (currentPayload) transmit(currentPayload.name, currentPayload.bytes, false);
  });

  // built-in test frame — verify the whole link without picking a file
  $('btnTest').addEventListener('click', () => {
    if (toneOsc) stopTone();
    const msg = 'SPIDERTEC SONIC TRANSFER // TEST PATTERN\n' +
      'If you can read this, the acoustic link works. ☢\n' +
      '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz';
    transmit('TEST-PATTERN.txt', new TextEncoder().encode(msg), true);
  });

  // continuous sync-frequency carrier — calibrate volume / SYNC LOCK meter
  let toneOsc = null, toneGain = null;
  function stopTone() {
    if (toneOsc) { try { toneOsc.stop(); } catch (_) {} toneOsc.disconnect(); toneOsc = null; }
    if (toneGain) { toneGain.disconnect(); toneGain = null; }
    $('btnTone').textContent = '♪ SYNC TONE';
    $('btnTone').classList.remove('active');
    if (!txSource) setMode('IDLE');
    log('Sync test tone off.', 'info');
  }
  $('btnTone').addEventListener('click', () => {
    if (toneOsc) { stopTone(); return; }
    ensureCtx();
    toneOsc = ctx.createOscillator();
    toneOsc.type = 'sine';
    toneOsc.frequency.value = cfg.syncFreq;
    toneGain = ctx.createGain();
    toneGain.gain.value = cfg.volume;
    toneOsc.connect(toneGain);
    toneGain.connect(vizAnalyser);              // tap for the scopes
    toneGain.connect(ctx.destination);          // play
    toneOsc.start();
    setMode('TRANSMIT');
    $('btnTone').textContent = '■ STOP TONE';
    $('btnTone').classList.add('active');
    log(`Holding sync tone @ ${cfg.syncFreq} Hz — watch the receiver's SYNC LOCK bar.`, 'ok');
  });

  // calibration sweep — receiver uses it to set gain + per-tone EQ
  function transmitCalibration() {
    if (toneOsc) stopTone();
    ensureCtx();
    setMode('TRANSMIT');
    log('=== TRANSMITTING CALIBRATION SWEEP ===', 'warn');
    const pcm = Modem.encodeCalibration(cfg);
    const buffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buffer.copyToChannel(pcm, 0);
    txSource = ctx.createBufferSource();
    txSource.buffer = buffer;
    txSource.connect(vizAnalyser); txSource.connect(ctx.destination);
    $('btnTransmit').disabled = true; $('btnTest').disabled = true; $('btnStopTx').disabled = false;
    const dur = pcm.length / ctx.sampleRate, t0 = ctx.currentTime;
    txSource.start();
    log(`Calibration sweep… ${dur.toFixed(1)}s (sync + 16 tones ×${Modem.CAL.repeats})`, 'info');
    const tick = setInterval(() => {
      const p = Math.min(100, ((ctx.currentTime - t0) / dur) * 100);
      $('sigBar').style.width = p + '%'; if (p >= 100) clearInterval(tick);
    }, 80);
    txSource.onended = () => {
      clearInterval(tick); $('sigBar').style.width = '0%';
      $('btnTransmit').disabled = !currentPayload; $('btnTest').disabled = false; $('btnStopTx').disabled = true;
      setMode('IDLE'); log('=== CALIBRATION SWEEP COMPLETE ===', 'ok');
    };
  }
  $('btnCalTx').addEventListener('click', transmitCalibration);

  // full-spectrum band scan — receiver measures it and recommends the best band
  function transmitBandScan() {
    if (toneOsc) stopTone();
    ensureCtx();
    setMode('TRANSMIT');
    log('=== TRANSMITTING BAND SCAN (full-spectrum sweep) ===', 'warn');
    const pcm = Modem.encodeBandScan(cfg);
    const buffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buffer.copyToChannel(pcm, 0);
    txSource = ctx.createBufferSource();
    txSource.buffer = buffer;
    txSource.connect(vizAnalyser); txSource.connect(ctx.destination);
    $('btnTransmit').disabled = true; $('btnTest').disabled = true; $('btnStopTx').disabled = false;
    const dur = pcm.length / ctx.sampleRate, t0 = ctx.currentTime;
    txSource.start();
    log(`Band sweep… ${dur.toFixed(1)}s (${Modem.bandProbeFreqs().length} probes ×${Modem.BAND.repeats}, ${Modem.BAND.lo}–${Modem.BAND.hi} Hz)`, 'info');
    const tick = setInterval(() => {
      const p = Math.min(100, ((ctx.currentTime - t0) / dur) * 100);
      $('sigBar').style.width = p + '%'; if (p >= 100) clearInterval(tick);
    }, 80);
    txSource.onended = () => {
      clearInterval(tick); $('sigBar').style.width = '0%';
      $('btnTransmit').disabled = !currentPayload; $('btnTest').disabled = false; $('btnStopTx').disabled = true;
      setMode('IDLE'); log('=== BAND SCAN SWEEP COMPLETE ===', 'ok');
    };
  }
  $('btnBandTx').addEventListener('click', transmitBandScan);

  $('btnStopTx').addEventListener('click', () => {
    if (txSource) { try { txSource.stop(); } catch (_) {} }
  });

  // WAV export
  $('btnWav').addEventListener('click', () => {
    if (!lastEncoded) return;
    const wav = encodeWav(lastEncoded.pcm, ctx.sampleRate);
    const name = (currentPayload ? currentPayload.name : 'transfer') + '.sonic.wav';
    downloadBlob(new Blob([wav], { type: 'audio/wav' }), name);
    log(`Saved waveform → ${name}`, 'ok');
  });

  function encodeWav(pcm, sr) {
    const n = pcm.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wr(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      let s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return buf;
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ------------------------------------------------------------- RECV controls
  // RX audio-path state (declared up here so the control bindings below can
  // reference `proc` to auto-disarm on a change that needs a fresh ARM).
  let micStream = null, micSource = null, proc = null, muteGain = null;
  const rcfg = Modem.defaultConfig();
  // These params are snapshotted when the receiver is armed (they set Ns / stride /
  // band / timing), so changing one mid-listen can't apply in place — disarm so the
  // operator knows to re-ARM (or just use REPLAY, which re-reads everything).
  function requireRearm() {
    if (proc) {
      stopRx();
      log('Setting changed — receiver disarmed. Press ARM RECEIVER (or REPLAY) to apply.', 'warn');
    }
  }
  bindRange('rsymRange', 'rsymOut', v => v + ' ms', v => { rcfg.symbolMs = v; requireRearm(); });
  bindRange('rgapRange', 'rgapOut', v => v + ' ms', v => { rcfg.gapMs = v; requireRearm(); });
  bindRange('rf0Range', 'rf0Out', v => v + ' Hz', v => { rcfg.f0 = v; rcfg.syncFreq = v - 200; requireRearm(); });
  bindRange('rspRange', 'rspOut', v => v + ' Hz', v => { rcfg.spacing = v; requireRearm(); });
  let erasureThresh = 1.8;
  bindRange('thRange', 'thOut', v => (v / 10).toFixed(1) + '×', v => erasureThresh = v / 10);  // live
  let inputGainNode = null;
  bindRange('rgainRange', 'rgainOut', v => (v / 10).toFixed(1) + '×',
    v => { if (inputGainNode) inputGainNode.gain.value = v / 10; });                            // live
  bindRange('rjitRange', 'rjitOut', v => v === 0 ? 'OFF' : v + '%', v => { rcfg.trackRange = v / 100; requireRearm(); });
  bindRange('rtgnRange', 'rtgnOut', v => (v / 100).toFixed(2), v => { rcfg.trackGain = v / 100; requireRearm(); });
  $('rbitsSel').addEventListener('change', e => { rcfg.bits = +e.target.value; buildEq(); renderEq(); requireRearm(); });

  // RX banner state (clearer arrival / completion indication)
  function setRxState(cls, text) {
    const el = $('rxStatus');
    el.className = 'rx-status ' + cls;
    el.textContent = text;
  }

  // live "FRAME DETECT" readout — everything the receiver pulls from the frame
  let detect = {};
  const DETECT_ORDER = ['BAND', 'CALIB', 'SYNC', 'SIZE', 'CORRECTION', 'SYMBOLS', 'DESCRIPTOR',
    'FILE', 'PAYLOAD', 'CORRECTED', 'CRC32', 'TIMING'];
  function renderDetect() {
    const el = $('rxDetect');
    const rows = DETECT_ORDER.filter(k => detect[k]).map(k => {
      const v = detect[k];
      return `<div class="rd-row"><span class="rd-k">${k}</span>` +
        `<span class="rd-v ${v.cls || ''}">${v.text}</span></div>`;
    });
    if (!rows.length) { el.className = 'rx-detect'; el.innerHTML = ''; return; }
    el.className = 'rx-detect show';
    el.innerHTML = '<div class="rd-hdr">◢ FRAME DETECT ◣</div>' + rows.join('');
  }
  function setDetect(k, text, cls) { detect[k] = { text, cls }; renderDetect(); }
  function clearDetect() { detect = {}; renderDetect(); }

  // =========================================================================
  //  RECEIVER  (streaming Goertzel demodulator)
  // =========================================================================
  let rx = null;
  let rxCalib = { eq: null };          // per-tone equaliser from calibration

  class Receiver {
    constructor(rcfg) {
      this.cfg = Object.assign({}, rcfg);
      this.cfg.sampleRate = ctx.sampleRate;
      this.Ns = Math.round(this.cfg.symbolMs / 1000 * ctx.sampleRate);
      this.Ng = Math.round((this.cfg.gapMs || 0) / 1000 * ctx.sampleRate); // silent gap
      this.S = this.Ns + this.Ng;                                          // symbol stride
      const tr = (this.cfg.trackRange != null) ? this.cfg.trackRange : 0.4;
      this.maxJit = Math.floor(this.Ns * tr);              // per-symbol timing-recovery search range
      this.trackGain = (this.cfg.trackGain != null) ? this.cfg.trackGain : 0.5; // clock feedback gain
      this.drift = 0;                                      // tracked symbol-clock offset (samples)
      this.cap = ctx.sampleRate * 30;          // 30s ring
      this.samples = new Float32Array(this.cap);
      this.len = 0;
      this.scanPos = 0;
      this.state = 'IDLE';
      this.inSync = false; this.syncStart = 0;
      this.s0 = 0; this.symIndex = 0;
      this.nibbles = []; this.confs = [];
      this.expected = null;                    // total data symbols (from descriptor)
      this.dataNibbleCount = null;
      this.descNibbles = [];                   // size-descriptor symbols
      this.dataSymOffset = Modem.descSymbols(this.cfg.bits); // data starts after the descriptor
      this.lastActivity = 0;
      this.silence = 0;                        // consecutive carrier-less symbols
      this.calMode = false; this.calS0 = null; // channel calibration capture
      this.bandMode = false; this.bandS0 = null; // full-spectrum band scan capture
    }

    push(chunk) {
      if (this.len + chunk.length > this.cap) {
        // shift out the consumed prefix to make room
        const keepFrom = Math.max(0, this.scanPos - this.Ns * 2);
        this.samples.copyWithin(0, keepFrom, this.len);
        this.len -= keepFrom;
        this.scanPos -= keepFrom; this.s0 -= keepFrom; this.syncStart -= keepFrom;
        if (this.len + chunk.length > this.cap) return; // payload too large
      }
      this.samples.set(chunk, this.len);
      this.len += chunk.length;
      this.process();
      this.updateSyncMeter();
    }

    // Live strength of the sync lead-in tone over the most recent window.
    // Lets the operator confirm the receiver actually hears the transmitter.
    updateSyncMeter() {
      if (this.len < this.Ns) return;
      const c = Modem.concentration(this.samples, this.len - this.Ns, this.Ns,
        this.cfg.syncFreq, this.cfg.sampleRate);
      let pct = (c.conc / (this.Ns * 0.5)) * 100;
      if (!isFinite(pct) || pct < 0) pct = 0; else if (pct > 100) pct = 100;
      const bar = $('syncStrBar');
      bar.style.width = pct.toFixed(0) + '%';
      bar.classList.toggle('hot', pct >= 12);   // 12% == lock-detection threshold
      $('syncStrVal').textContent = pct.toFixed(0) + '%';
    }

    process() {
      const Ns = this.Ns;
      if (this.bandMode) { this.bandScan(); return; }
      if (this.calMode) { this.calibrate(); return; }

      // ---- sync search (coarse scan + magic-aligned data start) ----
      if (this.state === 'IDLE') {
        const r = Modem.scanForSync(this.samples, this.scanPos, this.len, this.cfg);
        if (!r.found) {
          this.scanPos = r.nextScan;
          if (r.sensing) {
            setRxState('sensing', '◌ CARRIER SENSED — VALIDATING FRAME…');
          } else {
            const cur = $('rxStatus').className;       // don't clobber done/error/cold
            if (cur.includes('sensing') || cur.includes('scanning'))
              setRxState('scanning', 'RECEIVER ARMED :: SCANNING FOR CARRIER…');
          }
          return;
        }
        this.s0 = r.s0;
        this.scanPos = r.nextScan;
        this.state = 'DESC'; this.symIndex = 0;
        this.nibbles = []; this.confs = []; this.descNibbles = [];
        this.expected = null; this.dataNibbleCount = null;
        this.lastActivity = this.s0;
        this.silence = 0; this.drift = 0;
        log('▣ SYNC LOCK — reading size descriptor…', 'rx');
        setRxState('incoming', '▼▼  INCOMING TRANSMISSION  ▼▼');
        $('rxProgress').style.width = '0%';
        clearDetect();
        setDetect('SYNC', '◉ locked', 'ok');
      }

      // ---- size descriptor: learn exactly how much to receive ----
      if (this.state === 'DESC') {
        while (this.descNibbles.length < Modem.descSymbols(this.cfg.bits)) {
          const idx = this.descNibbles.length;
          const center = this.s0 + idx * this.S + Math.floor(Ns / 2) + Math.round(this.drift);
          if (center + this.maxJit + Math.floor(Ns * 0.5) >= this.len) return; // wait for more audio
          const d = Modem.demodSymbolAligned(this.samples, center, this.cfg, rxCalib.eq, this.maxJit);
          if (d.conf > 1.5) this.drift += this.trackGain * d.offset;   // track the symbol clock
          this.descNibbles.push(d.sym);
        }
        const desc = Modem.parseDescriptor(this.descNibbles, this.cfg.bits);
        if (desc.frameBytes <= 0 || desc.frameBytes > 5_000_000) {
          log('✗ Bad size descriptor — false lock, re-scanning…', 'warn');
          this.resetToScan(); return;
        }
        if (!desc.ok) log('⚠ Size descriptor checksum failed — proceeding best-effort.', 'warn');
        this.mode = desc.mode; this.param = desc.param || 16; this.frameBytes = desc.frameBytes;
        const plan = Modem.ecPlan(this.frameBytes, this.mode, this.param, this.cfg.bits);
        this.expected = plan.totalSymbols;
        this.dataNibbleCount = plan.dataNibbles;
        const modeTxt = this.mode === 2 ? `Reed-Solomon` : this.mode === 1 ? `XOR-FEC` : 'no FEC';
        const strengthTxt = this.mode === 2 ? `${this.param} B parity (±${this.param >> 1}/cw)`
          : this.mode === 1 ? `1:${this.param}` : '—';
        log(`Size descriptor OK :: ${this.frameBytes} B frame · ${plan.totalSymbols} symbols · ${modeTxt}`, 'rx');
        setRxState('incoming', `▼  RECEIVING · ${this.frameBytes} B frame  ▼`);
        setDetect('SIZE', `${this.frameBytes} B frame`);
        setDetect('CORRECTION', `${modeTxt} · ${strengthTxt}`);
        setDetect('SYMBOLS', `${plan.totalSymbols} (${plan.parity} parity)`);
        setDetect('DESCRIPTOR', desc.ok ? 'CRC8 OK' : 'CRC8 FAILED', desc.ok ? 'ok' : 'warn');
        this.state = 'DECODE'; this.symIndex = 0;
        this.nibbles = []; this.confs = [];
      }

      // ---- payload symbol demodulation ----
      while (this.symIndex < (this.expected || Infinity)) {
        const center = this.s0 + (this.dataSymOffset + this.symIndex) * this.S + Math.floor(Ns / 2) + Math.round(this.drift);
        if (center + this.maxJit + Math.floor(Ns * 0.5) >= this.len) return; // wait for more audio
        const d = Modem.demodSymbolAligned(this.samples, center, this.cfg, rxCalib.eq, this.maxJit);
        if (d.conf > 1.5) this.drift += this.trackGain * d.offset;   // track the symbol clock
        this.nibbles.push(d.sym);
        this.confs.push(d.conf);
        this.symIndex++;

        // carrier-lost detection: if no real tone stands out for a sustained
        // stretch, the transmission ended/dropped without a clean finish.
        if (d.conf < 1.25) this.silence++; else this.silence = 0;
        if (this.silence > Math.ceil(1500 / this.cfg.symbolMs)) {
          log('⚠ Carrier lost — transmission incomplete or ended; auto-resetting.', 'warn');
          this.resetToScan();
          return;
        }

        if (this.symIndex >= this.expected) { this.finish(); return; }
      }
    }

    finish() {
      // ---- error correction (Reed-Solomon / XOR parity / none) ----
      const recon = Modem.ecReconstruct(this.nibbles, this.confs, this.frameBytes,
        this.mode, this.param, erasureThresh, this.cfg.bits);
      const bytes = recon.frame;
      const repaired = recon.repaired;
      if (this.mode === 2 && repaired > 0) log(`✚ Reed-Solomon corrected ${repaired} byte error(s).`, 'ok');
      else if (this.mode === 2 && repaired < 0) log('! Reed-Solomon: codeword(s) beyond repair.', 'warn');
      else if (this.mode === 1 && repaired > 0) log(`✚ XOR-FEC repaired ${repaired} nibble(s).`, 'ok');

      const nameLen = bytes[5];
      const o = 6 + nameLen;
      const dataLen = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
      const dataStart = 6 + nameLen + 4;
      const data = bytes.subarray(dataStart, dataStart + dataLen);
      const name = new TextDecoder().decode(bytes.subarray(6, 6 + nameLen));
      const crcStored = (bytes[dataStart + dataLen] << 24) | (bytes[dataStart + dataLen + 1] << 16)
        | (bytes[dataStart + dataLen + 2] << 8) | bytes[dataStart + dataLen + 3];
      const crcCalc = Modem.crc32(bytes.subarray(0, dataStart + dataLen));
      const ok = (crcStored >>> 0) === (crcCalc >>> 0);

      this.resetToScan();                 // reset decode state for the next message
      $('rxProgress').style.width = '100%';
      const shownRepair = repaired > 0 ? repaired : 0;

      setDetect('FILE', name || '—');
      setDetect('PAYLOAD', `${dataLen} B`);
      if (this.mode === 2) setDetect('CORRECTED', repaired < 0 ? 'uncorrectable' : `${shownRepair} byte(s)`, repaired < 0 ? 'err' : '');
      else if (this.mode === 1) setDetect('CORRECTED', `${shownRepair} nibble(s)`);
      setDetect('CRC32', ok ? 'VERIFIED ✓' : 'MISMATCH ✗', ok ? 'ok' : 'err');
      const driftMs = this.drift / this.cfg.sampleRate * 1000;
      setDetect('TIMING', `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms drift`);
      log(`Symbol-clock drift tracked over the frame: ${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms`, 'info');

      // either way the receiver stays armed and keeps listening — never halts
      const stillArmed = !!proc;
      if (ok) {
        log(`=== ✓ PAYLOAD VERIFIED :: ${name} (${dataLen} B) ${shownRepair ? `[${shownRepair} corrected]` : ''} ===`, 'ok');
        setRxState('done', `✓✓  TRANSMISSION COMPLETE · ${name} (${dataLen} B)  ✓✓`);
      } else {
        log(`=== ✗ CRC FAIL :: ${name} (${dataLen} B) — saved anyway, still listening… ===`, 'warn');
        setRxState('error', `✗  CRC FAIL · ${name} — saved anyway · still listening  ✗`);
      }
      showResult(name, data, ok, shownRepair, this.mode);
      setMode(stillArmed ? 'RECEIVE' : 'IDLE');   // keep working, don't drop to ERROR
    }

    // listen for the transmitter's calibration sweep, then build an equaliser
    // and auto-set input gain from the measured per-tone levels.
    calibrate() {
      if (this.calS0 == null) {
        const r = Modem.findSyncEdge(this.samples, this.scanPos, this.len, this.cfg);
        if (!r.found) {
          this.scanPos = r.nextScan;
          if (r.sensing) setRxState('sensing', '◌ CALIBRATION — tone heard, aligning…');
          return;
        }
        this.calS0 = r.s0; this.scanPos = r.nextScan;
        log('▣ Calibration tone locked — measuring channel response…', 'rx');
        setRxState('incoming', '▣  CALIBRATING — measuring tones…');
      }
      const sr = this.cfg.sampleRate;
      const M = Modem.numTones(this.cfg);
      const Tcal = Math.round(Modem.CAL.toneMs / 1000 * sr);
      const slots = Modem.CAL.repeats * M;
      const need = this.calS0 + slots * Tcal + Math.floor(Tcal * 0.5);
      if (this.len < need) return;                 // wait for the whole sweep

      const use = Math.floor(Tcal * 0.6);
      const energy = new Array(M).fill(0), cnt = new Array(M).fill(0);
      let peak = 0;
      for (let j = 0; j < slots; j++) {
        const tone = j % M;
        const center = this.calS0 + j * Tcal + Math.floor(Tcal / 2);
        const st = center - Math.floor(use / 2);
        energy[tone] += Modem.goertzel(this.samples, st, use, Modem.dataFreq(this.cfg, tone), sr);
        cnt[tone]++;
        for (let i = st; i < st + use; i++) { const a = Math.abs(this.samples[i]); if (a > peak) peak = a; }
      }
      for (let k = 0; k < M; k++) energy[k] /= Math.max(1, cnt[k]);
      const mean = energy.reduce((a, b) => a + b, 0) / M;
      if (mean <= 1e-9) {
        log('✗ Calibration failed — no tones heard. Raise volume / check mic.', 'err');
        setRxState('error', '✗  CALIBRATION FAILED — no signal');
        this.calMode = false; this.calS0 = null; return;
      }
      // per-tone equaliser (attenuated tones get boosted), clamped
      const eq = energy.map(e => Math.min(4, Math.max(0.25, mean / (e + 1e-12))));
      // auto input gain from mean tone amplitude
      const measuredA = 2 * Math.sqrt(mean) / use;
      const curGain = inputGainNode ? inputGainNode.gain.value : 1;
      let newGain = curGain * (measuredA > 1e-6 ? 0.4 / measuredA : 1);
      if (peak > 0.99) newGain = Math.min(newGain, curGain * 0.7);   // back off if clipping
      newGain = Math.min(20, Math.max(0.1, newGain));

      rxCalib.eq = eq;
      renderEq();
      if (inputGainNode) inputGainNode.gain.value = newGain;
      $('rgainRange').value = Math.round(newGain * 10);
      $('rgainOut').textContent = newGain.toFixed(1) + '×';

      const lo = Math.min.apply(null, eq).toFixed(2), hi = Math.max.apply(null, eq).toFixed(2);
      log(`✓ CALIBRATED :: input gain ${newGain.toFixed(1)}× · per-tone EQ ${lo}–${hi}× applied`, 'ok');
      setRxState('done', `✓✓  CALIBRATED · gain ${newGain.toFixed(1)}× · EQ on  ✓✓`);
      clearDetect();
      setDetect('CALIB', `gain ${newGain.toFixed(1)}× · EQ ${lo}–${hi}×`, 'ok');
      setMode(proc ? 'RECEIVE' : 'IDLE');

      this.scanPos = Math.max(this.scanPos, need + this.Ns);   // skip past the sweep
      this.calMode = false; this.calS0 = null;
    }

    // listen for the transmitter's full-spectrum sweep, measure the channel
    // response across the whole probe grid, then recommend the best data band.
    bandScan() {
      const sr = this.cfg.sampleRate;
      const freqs = Modem.bandProbeFreqs();
      if (this.bandS0 == null) {
        // the sweep uses a FIXED lead-in tone, independent of either side's f0
        const scfg = Object.assign({}, this.cfg, { syncFreq: Modem.BAND.syncFreq });
        const r = Modem.findSyncEdge(this.samples, this.scanPos, this.len, scfg);
        if (!r.found) {
          this.scanPos = r.nextScan;
          if (r.sensing) setRxState('sensing', '◌ BAND SCAN — lead tone heard, aligning…');
          return;
        }
        this.bandS0 = r.s0; this.scanPos = r.nextScan;
        log('▣ Band-scan tone locked — sweeping the spectrum…', 'rx');
        setRxState('incoming', '▣  BAND SCAN — measuring spectrum…');
      }
      const Tt = Math.round(Modem.BAND.toneMs / 1000 * sr);
      const slots = Modem.BAND.repeats * freqs.length;
      const need = this.bandS0 + slots * Tt + Math.floor(Tt * 0.5);
      if (this.len < need) return;                 // wait for the whole sweep

      const use = Math.floor(Tt * 0.6);
      const energy = new Array(freqs.length).fill(0), cnt = new Array(freqs.length).fill(0);
      let peak = 0;
      for (let j = 0; j < slots; j++) {
        const fi = j % freqs.length;
        const center = this.bandS0 + j * Tt + Math.floor(Tt / 2);
        const st = center - Math.floor(use / 2);
        energy[fi] += Modem.goertzel(this.samples, st, use, freqs[fi], sr);
        cnt[fi]++;
        for (let i = st; i < st + use; i++) { const a = Math.abs(this.samples[i]); if (a > peak) peak = a; }
      }
      for (let k = 0; k < freqs.length; k++) energy[k] /= Math.max(1, cnt[k]);
      if (energy.reduce((a, b) => a + b, 0) <= 1e-9) {
        log('✗ Band scan failed — no tones heard. Raise volume / check mic.', 'err');
        setRxState('error', '✗  BAND SCAN FAILED — no signal');
        this.bandMode = false; this.bandS0 = null; return;
      }

      const pick = Modem.pickBand(energy, freqs, this.cfg.bits);

      // per-tone equaliser for the chosen band + auto input gain (mirrors calibrate)
      const meanE = pick.toneE.reduce((a, b) => a + b, 0) / pick.toneE.length;
      const eq = pick.toneE.map(e => Math.min(4, Math.max(0.25, meanE / (e + 1e-12))));
      const measuredA = 2 * Math.sqrt(Math.max(meanE, 0)) / use;
      const curGain = inputGainNode ? inputGainNode.gain.value : 1;
      let newGain = curGain * (measuredA > 1e-6 ? 0.4 / measuredA : 1);
      if (peak > 0.99) newGain = Math.min(newGain, curGain * 0.7);
      newGain = Math.min(20, Math.max(0.1, newGain));

      // apply the chosen band to the receiver (and its sliders)
      rxCalib.eq = eq;
      renderEq();
      rcfg.f0 = pick.f0; rcfg.spacing = pick.spacing; rcfg.syncFreq = pick.syncFreq;
      if (inputGainNode) inputGainNode.gain.value = newGain;
      $('rf0Range').value = pick.f0; $('rf0Out').textContent = pick.f0 + ' Hz';
      $('rspRange').value = pick.spacing; $('rspOut').textContent = pick.spacing + ' Hz';
      $('rgainRange').value = Math.round(newGain * 10); $('rgainOut').textContent = newGain.toFixed(1) + '×';

      const top = pick.f0 + 15 * pick.spacing;
      log(`✓ BAND SELECTED :: ${pick.f0}–${top} Hz · spacing ${pick.spacing} Hz · sync ${pick.syncFreq} Hz`, 'ok');
      log(`➤ SET ON TRANSMITTER → BASE FREQ ${pick.f0} Hz · TONE SPACING ${pick.spacing} Hz`, 'warn');
      setRxState('done', `✓✓  BAND READY · SET TX → BASE ${pick.f0} Hz · SPACING ${pick.spacing} Hz  ✓✓`);
      clearDetect();
      setDetect('BAND', `${pick.f0}–${top} Hz · sp ${pick.spacing}`, 'ok');
      setDetect('CALIB', `gain ${newGain.toFixed(1)}× · EQ on`, 'ok');
      setMode(proc ? 'RECEIVE' : 'IDLE');

      this.scanPos = Math.max(this.scanPos, need + this.Ns);   // skip past the sweep
      this.bandMode = false; this.bandS0 = null;
    }

    resetToScan() {
      const consumed = this.dataSymOffset + this.symIndex;   // descriptor + data read
      this.state = 'IDLE'; this.inSync = false; this.drift = 0;
      this.scanPos = Math.max(this.scanPos, this.s0 + consumed * this.S);
      this.expected = null; this.dataNibbleCount = null;
      this.descNibbles = [];
      setRxState('scanning', 'RECEIVER ARMED :: SCANNING FOR CARRIER…');
      $('rxProgress').style.width = '0%';
    }

    progressPct() {
      if (this.expected) return Math.min(100, this.symIndex / this.expected * 100);
      return 0;
    }
  }

  // ------------------------------------------------------- audio input devices
  async function populateInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const sel = $('audioInput');
      const prev = sel.value;
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = ''; def.textContent = 'SYSTEM DEFAULT';
      sel.appendChild(def);
      inputs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = (d.label || `INPUT ${i + 1}`).toUpperCase();
        sel.appendChild(o);
      });
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
      log(`Audio inputs detected: ${inputs.length}`, 'info');
    } catch (e) {
      log('Could not enumerate inputs: ' + e.message, 'warn');
    }
  }
  $('btnRefreshInputs').addEventListener('click', populateInputs);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateInputs);
  }
  // re-arm with a new device if the operator switches mid-listen
  $('audioInput').addEventListener('change', async () => {
    if (proc) { stopRx(); await armReceiver(); }
  });

  // ------------------------------------------------------------- RX audio path
  $('btnListen').addEventListener('click', armReceiver);

  async function armReceiver() {
    try {
      ensureCtx();
      const deviceId = $('audioInput').value;
      const audioConstraints = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      };
      if (deviceId) audioConstraints.deviceId = { exact: deviceId };
      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      populateInputs(); // labels become available once permission is granted
      micSource = ctx.createMediaStreamSource(micStream);

      // operator-controlled input gain feeds both the scopes and the demodulator
      inputGainNode = ctx.createGain();
      inputGainNode.gain.value = (+$('rgainRange').value) / 10;
      micSource.connect(inputGainNode);
      inputGainNode.connect(vizAnalyser);

      proc = ctx.createScriptProcessor(4096, 1, 1);
      rx = new Receiver(rcfg);
      tapeReset();                       // start a fresh capture for this session
      proc.onaudioprocess = (e) => {
        const copy = new Float32Array(e.inputBuffer.getChannelData(0));
        tapePush(copy);                  // keep the raw audio for REPLAY DECODE
        rx.push(copy);
        if (rx.expected) $('rxProgress').style.width = rx.progressPct() + '%';
      };
      muteGain = ctx.createGain(); muteGain.gain.value = 0;
      inputGainNode.connect(proc); proc.connect(muteGain); muteGain.connect(ctx.destination);

      setMode('RECEIVE');
      $('btnListen').disabled = true; $('btnStopRx').disabled = false;
      setRxState('scanning', 'RECEIVER ARMED :: SCANNING FOR CARRIER…');
      $('rxResult').hidden = true;
      const devTxt = $('audioInput').selectedOptions[0]
        ? $('audioInput').selectedOptions[0].textContent : 'DEFAULT';
      log(`◉ Receiver armed on [${devTxt}] — listening for carrier…`, 'rx');
    } catch (err) {
      log('✗ Microphone access denied: ' + err.message, 'err');
      setMode('ERR');
    }
  }

  // RESET: abort an in-progress (possibly stalled) decode and clear the result,
  // even when no completion was ever detected.
  $('btnResetRx').addEventListener('click', () => {
    if (rx) rx.resetToScan();
    clearResult();
    log('↺ Receiver decode state reset.', 'info');
  });

  // CALIBRATE: arm the receiver and listen for the transmitter's calibration sweep
  $('btnCalRx').addEventListener('click', async () => {
    if (!proc) await armReceiver();
    if (!rx) return;
    rx.calMode = true; rx.calS0 = null; rx.bandMode = false;
    clearDetect();
    log('◉ Calibration armed — now press CALIBRATE on the transmitter.', 'rx');
    setRxState('sensing', '◌ CALIBRATION ARMED — play CALIBRATE from transmitter…');
  });

  // FIND BAND: arm the receiver and listen for the transmitter's full-spectrum
  // sweep, then auto-pick the best data band and show what to set on the TX.
  $('btnBandRx').addEventListener('click', async () => {
    if (!proc) await armReceiver();
    if (!rx) return;
    rx.bandMode = true; rx.bandS0 = null; rx.calMode = false;
    clearDetect();
    log('◉ Band scan armed — now press FIND BAND on the transmitter.', 'rx');
    setRxState('sensing', '◌ BAND SCAN ARMED — play FIND BAND from transmitter…');
  });

  $('btnStopRx').addEventListener('click', stopRx);
  function stopRx() {
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; proc = null; }
    if (inputGainNode) { inputGainNode.disconnect(); inputGainNode = null; }
    if (micSource) { micSource.disconnect(); micSource = null; }
    if (muteGain) { muteGain.disconnect(); muteGain = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    $('btnListen').disabled = false; $('btnStopRx').disabled = true;
    $('syncStrBar').style.width = '0%'; $('syncStrBar').classList.remove('hot');
    $('syncStrVal').textContent = '0%';
    clearDetect();
    setRxState('cold', 'RECEIVER COLD');
    setMode('IDLE');
    log('Receiver disarmed.', 'info');
  }

  // ---------------------------------------------------- capture tape (debug)
  // Records the full mic session (in memory only) so the operator can REPLAY it
  // back through the decoder offline — re-decode the exact same recording while
  // tweaking ERASURE THRESH / EQ / band / timing, without needing the transmitter.
  let tapeChunks = [], tapeSamples = 0, replaying = false;
  const TAPE_MAX_SEC = 120;
  function tapeReset() { tapeChunks = []; tapeSamples = 0; updateTapeUI(); }
  function tapePush(ch) {
    tapeChunks.push(ch); tapeSamples += ch.length;
    const cap = ctx.sampleRate * TAPE_MAX_SEC;          // bound memory: keep last ~2 min
    while (tapeSamples > cap && tapeChunks.length > 1) tapeSamples -= tapeChunks.shift().length;
    updateTapeUI();
  }
  function tapeFlatten() {
    const out = new Float32Array(tapeSamples);
    let o = 0; for (const c of tapeChunks) { out.set(c, o); o += c.length; }
    return out;
  }
  function updateTapeUI() {
    const has = tapeSamples > 0, sr = ctx ? ctx.sampleRate : 48000;
    $('btnReplay').disabled = !has || replaying;
    $('tapeInfo').textContent = has ? `${(tapeSamples / sr).toFixed(1)}s captured` : 'no recording';
  }
  $('btnReplay').addEventListener('click', () => {
    if (!tapeSamples || replaying) return;
    ensureCtx();
    if (proc) stopRx();                  // stop live capture so it doesn't mix in
    replaying = true; updateTapeUI();
    clearResult();                       // also clears the FRAME DETECT panel
    const tape = tapeFlatten();
    log(`▶ REPLAY :: re-decoding ${(tape.length / ctx.sampleRate).toFixed(1)}s with current settings…`, 'rx');
    setMode('RECEIVE');
    rx = new Receiver(rcfg);
    const block = 4096;
    let i = 0;
    const pump = () => {                  // feed in bursts so the UI/log can update live
      const burstEnd = Math.min(i + block * 16, tape.length);
      for (; i < burstEnd; i += block) rx.push(tape.subarray(i, Math.min(i + block, tape.length)));
      if (rx.expected) $('rxProgress').style.width = rx.progressPct() + '%';
      if (i < tape.length) { setTimeout(pump, 0); return; }
      replaying = false; updateTapeUI(); setMode('IDLE');
      log('▶ Replay finished.', 'info');
    };
    pump();
  });

  // ----------------------------------------------------------- result + preview
  let lastPreviewUrl = null;
  function clearResult() {
    $('rxResult').hidden = true;
    $('rrMeta').innerHTML = '';
    $('rrPreview').innerHTML = '';
    if (lastPreviewUrl) { URL.revokeObjectURL(lastPreviewUrl); lastPreviewUrl = null; }
    $('rxProgress').style.width = '0%';
    clearDetect();
    setRxState(proc ? 'scanning' : 'cold',
      proc ? 'RECEIVER ARMED :: SCANNING FOR CARRIER…' : 'RECEIVER COLD');
    log('Received payload cleared.', 'info');
  }
  $('btnClear').addEventListener('click', clearResult);

  function showResult(name, data, ok, repaired, mode) {
    if (lastPreviewUrl) { URL.revokeObjectURL(lastPreviewUrl); lastPreviewUrl = null; }
    $('rxResult').hidden = false;
    const repUnit = mode === 2 ? 'byte(s) via Reed-Solomon' : 'nibble(s) via XOR-FEC';
    $('rrMeta').innerHTML =
      `FILE: <b>${name}</b><br>SIZE: ${data.length} bytes<br>` +
      `INTEGRITY: ${ok ? '<span style="color:var(--blue)">CRC32 VERIFIED ✓</span>'
                       : '<span style="color:var(--red)">CRC32 MISMATCH ✗</span>'}` +
      (repaired ? `<br>REPAIRED: <span style="color:#c9a04a">${repaired} ${repUnit}</span>` : '');

    const preview = $('rrPreview'); preview.innerHTML = '';
    const lower = name.toLowerCase();
    const blob = new Blob([data]);
    if (/\.(png|jpg|jpeg|gif|bmp|webp)$/.test(lower)) {
      const img = document.createElement('img');
      lastPreviewUrl = URL.createObjectURL(blob);
      img.src = lastPreviewUrl; preview.appendChild(img);
    } else if (/\.(txt|md|json|csv|log|js|html|xml|ini|cfg)$/.test(lower) || isMostlyText(data)) {
      preview.textContent = new TextDecoder().decode(data.subarray(0, 4000));
    } else {
      preview.textContent = hexDump(data.subarray(0, 256));
    }
    $('btnSave').onclick = () => { downloadBlob(blob, name); log(`Saved → ${name}`, 'ok'); };
  }
  function isMostlyText(data) {
    const n = Math.min(data.length, 512); let printable = 0;
    for (let i = 0; i < n; i++) { const c = data[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++; }
    return n > 0 && printable / n > 0.85;
  }
  function hexDump(data) {
    let out = '';
    for (let i = 0; i < data.length; i += 16) {
      let hex = '', asc = '';
      for (let j = 0; j < 16 && i + j < data.length; j++) {
        const b = data[i + j];
        hex += b.toString(16).padStart(2, '0') + ' ';
        asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
      }
      out += i.toString(16).padStart(6, '0') + '  ' + hex.padEnd(48) + ' ' + asc + '\n';
    }
    return out;
  }

  // =========================================================================
  //  VISUALIZERS
  // =========================================================================
  function startViz() {
    const scope = $('scope'), sctx = scope.getContext('2d');
    const spec = $('spectrum'), pctx = spec.getContext('2d');
    const time = new Float32Array(vizAnalyser.fftSize);
    const freq = new Uint8Array(vizAnalyser.frequencyBinCount);

    function resize(c) { const r = c.getBoundingClientRect(); c.width = r.width; c.height = r.height; }
    const ro = () => { resize(scope); resize(spec); };
    window.addEventListener('resize', ro); ro();

    function draw() {
      rafId = requestAnimationFrame(draw);

      // ---- oscilloscope ----
      vizAnalyser.getFloatTimeDomainData(time);
      const W = scope.width, H = scope.height;
      sctx.fillStyle = 'rgba(2,12,6,0.35)'; sctx.fillRect(0, 0, W, H);
      // grid
      sctx.strokeStyle = 'rgba(19,74,38,0.6)'; sctx.lineWidth = 1; sctx.beginPath();
      for (let x = 0; x <= W; x += W / 10) { sctx.moveTo(x, 0); sctx.lineTo(x, H); }
      for (let y = 0; y <= H; y += H / 6) { sctx.moveTo(0, y); sctx.lineTo(W, y); }
      sctx.stroke();
      // trace
      sctx.strokeStyle = '#36ff7a'; sctx.lineWidth = 2;
      sctx.shadowColor = '#36ff7a'; sctx.shadowBlur = 8; sctx.beginPath();
      for (let i = 0; i < time.length; i++) {
        const x = (i / time.length) * W;
        const y = H / 2 - time[i] * (H / 2) * 0.92;
        i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
      }
      sctx.stroke(); sctx.shadowBlur = 0;

      // ---- spectrum ----
      vizAnalyser.getByteFrequencyData(freq);
      const SW = spec.width, SH = spec.height;
      pctx.fillStyle = '#020c06'; pctx.fillRect(0, 0, SW, SH);
      const nyq = ctx ? ctx.sampleRate / 2 : 24000;
      const maxHz = 4000, bins = Math.floor(freq.length * (maxHz / nyq));
      const bw = SW / bins;
      // highlight active data band
      const activeCfg = ($('recvView').hidden) ? cfg : rcfg;
      const loHz = activeCfg.f0, hiHz = activeCfg.f0 + 15 * activeCfg.spacing;
      pctx.fillStyle = 'rgba(70,214,255,0.10)';
      pctx.fillRect((loHz / maxHz) * SW, 0, ((hiHz - loHz) / maxHz) * SW, SH);
      // bars
      for (let i = 0; i < bins; i++) {
        const v = freq[i] / 255; const h = v * SH;
        const hz = (i / freq.length) * nyq;
        pctx.fillStyle = (hz >= loHz && hz <= hiHz) ? '#46d6ff'
          : (hz < activeCfg.f0 && hz > 100 ? '#c9a04a' : '#18b84e');
        pctx.fillRect(i * bw, SH - h, Math.max(1, bw - 1), h);
      }
      // signal meter
      let sum = 0; for (let i = 0; i < freq.length; i++) sum += freq[i];
      $('sigBar').style.width = Math.min(100, (sum / freq.length) * 1.6) + '%';
    }
    draw();
  }

  // ------------------------------------------------------------- hover help
  const HELP = {
    // TRANSMIT
    symRange: 'Duration of a single symbol. Longer = slower, but much more reliable (more resistant to noise and sync drift). 90–120 ms for a tricky channel.',
    gapRange: 'Silent gap inserted between symbols. Lets reverb / echo tails from one tone die down before the next, which can cut inter-symbol interference in a live room. Costs transmission time. MUST match the receiver. 0 = back-to-back (fastest).',
    f0Range: 'Frequency of the first of the 16 data tones. MUST be identical on the receiving side.',
    spRange: 'Spacing between the 16 tones. Wider = more noise-resistant, but takes up more bandwidth. Set it the same in the receiver.',
    volRange: 'Transmit volume through the speakers.',
    ecMode: 'Error-correction mode. REED–SOLOMON: fixes real byte errors (most reliable). XOR: only repairs "erasures" (low-confidence symbols), one per block. NONE: no correction.',
    bitsSel: 'Modulation order = bits per symbol. 16-FSK (4 bit) is the robust default. Higher (32/64-FSK) packs more bits per tone → faster, but the tones sit closer together so it needs a clean, wide channel. MUST match the receiver. Use FIND BAND first to make sure 2^bits tones fit the band.',
    rbitsSel: 'Modulation order = bits per symbol — MUST match the transmitter. Changing it re-sizes the per-tone EQ and disarms the receiver (press ARM / REPLAY to apply).',
    densRange: 'Correction strength. RS: number of parity bytes per codeword (fixes half that many errors). XOR: 1 parity nibble per N nibbles (smaller N = more repairs). Higher strength = longer transmission.',
    // RECEIVE
    rsymRange: 'Symbol duration — MUST match the transmitter. Longer = more reliable synchronization.',
    rgapRange: 'Silent gap between symbols — MUST match the transmitter (it changes where each symbol sits in time).',
    rf0Range: 'Base frequency — MUST be identical to the transmitter.',
    rspRange: 'Tone spacing — MUST be identical to the transmitter.',
    thRange: 'Symbol confidence threshold. Below it = the symbol is treated as "erased" and becomes a candidate for FEC repair. Higher = more repair attempts, but a risk of false ones.',
    rgainRange: 'Gain on the microphone signal — for the scopes and the decoder. Boost it when the signal is weak / the SYNC LOCK bar barely moves.',
    rjitRange: 'Timing recovery search range (per symbol, as a % of symbol length). The decoder re-centres each symbol on the strongest tone within ±this window to track speaker/mic clock drift. Wider = tolerates more drift but risks locking onto a neighbouring symbol. 0 = OFF (fixed stride). Try 30–45%. Applied on ARM / REPLAY.',
    rtgnRange: 'Timing recovery tracking gain — how hard the symbol clock chases the measured offset each symbol. Higher = locks onto drift faster but can get jittery on noise; lower = smoother but slower. 0.4–0.6 is a good range. Applied on ARM / REPLAY.',
    audioInput: 'Select the microphone / input device. ⟳ rescans the list.',
    eqBars: 'Per-tone equalizer applied on receive. Each bar is one of the 16 data tones (0–F); drag up to boost, down to cut. CALIBRATE / FIND BAND fill it in automatically; FLAT resets it. Handy to manually notch a tone your channel mangles.',
    // buttons
    btnTest: 'Transmits a built-in test frame with the current parameters — checks the whole link without picking a file.',
    btnTone: 'Holds a continuous sync tone. Turn it on and watch the SYNC LOCK bar in the receiver while adjusting volume / INPUT GAIN.',
    btnResetRx: 'Aborts the current decode (e.g. when it gets stuck) and clears the received file. Works even without a completed transmission.',
    btnCalTx: 'Transmits a calibration sequence (sync tone + a sweep of the 16 tones). The receiver uses it to set gain and a per-tone equalizer.',
    btnCalRx: 'Arms the receiver for calibration: listens for the sequence from the transmitter and automatically tunes INPUT GAIN and an EQ that compensates for channel attenuation.',
    btnBandTx: 'Transmits a wide full-spectrum sweep (≈600–4800 Hz). The receiver measures which part of the spectrum the channel passes best and recommends the optimal BASE FREQ / TONE SPACING.',
    btnBandRx: 'Arms the receiver to listen for the full-spectrum sweep. It auto-selects the best data band (and applies it on the receive side), then shows the BASE FREQ / TONE SPACING to set on the transmitter.',
    btnReplay: 'Re-runs the decoder offline on the captured recording (in memory, last ~2 min) using the CURRENT settings (ERASURE THRESH, EQ, band, timing). Tweak a slider, hit REPLAY, and reproduce a decode without needing the transmitter again.'
  };
  (() => {
    const tip = document.createElement('div');
    tip.id = 'st-tooltip';
    document.body.appendChild(tip);
    const move = (e) => {
      const pad = 14, r = tip.getBoundingClientRect();
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
    };
    Object.keys(HELP).forEach(id => {
      const el = $(id);
      if (!el) return;
      const target = el.closest('.ctl') || el;   // cover the label + slider together
      target.addEventListener('mouseenter', (e) => {
        tip.textContent = HELP[id]; tip.style.display = 'block'; move(e);
      });
      target.addEventListener('mousemove', move);
      target.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  })();

  // ------------------------------------------------------- per-tone EQ GUI
  // Visualises rxCalib.eq (the 16 per-tone weights). Bars centre on 1.0×; drag a
  // bar up to boost / down to cut a tone. CALIBRATE & FIND BAND fill it in.
  const EQ_MIN = 0.25, EQ_MAX = 4;
  const eqWeightToPos = (w) => Math.min(1, Math.max(0, 0.5 + Math.log2(w) / 4));
  const eqPosToWeight = (p) => Math.min(EQ_MAX, Math.max(EQ_MIN, Math.pow(2, (p - 0.5) * 4)));
  const eqTones = () => Modem.numTones(rcfg);
  function ensureEqArray() {
    const M = eqTones();
    if (!Array.isArray(rxCalib.eq) || rxCalib.eq.length !== M) rxCalib.eq = new Array(M).fill(1);
    return rxCalib.eq;
  }
  function renderEq() {
    const wrap = $('eqBars');
    const eq = rxCalib.eq;
    for (let i = 0; i < wrap.children.length; i++) {
      const col = wrap.children[i];
      const w = (Array.isArray(eq) && eq[i]) ? eq[i] : 1;
      const fill = col.querySelector('.eq-fill');
      fill.style.height = (eqWeightToPos(w) * 100).toFixed(1) + '%';
      fill.classList.toggle('cut', w < 0.98);
    }
  }
  function buildEq() {
    const wrap = $('eqBars');
    const M = eqTones();
    wrap.innerHTML = '';
    for (let i = 0; i < M; i++) {
      const col = document.createElement('div');
      col.className = 'eq-col'; col.dataset.i = i;
      col.innerHTML = '<div class="eq-track"><div class="eq-mid"></div><div class="eq-fill"></div></div>'
        + '<div class="eq-lbl">' + (M <= 16 ? i.toString(16).toUpperCase() : '') + '</div>';
      wrap.appendChild(col);
    }
    let dragging = null;
    const apply = (col, clientY) => {
      const i = +col.dataset.i;
      const r = col.querySelector('.eq-track').getBoundingClientRect();
      const pos = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      const w = eqPosToWeight(pos);
      ensureEqArray()[i] = w;
      renderEq();
      const f = rcfg.f0 + i * rcfg.spacing;
      $('eqTip').textContent = `tone ${i.toString(16).toUpperCase()} · ${f} Hz · ${w.toFixed(2)}×`;
    };
    wrap.addEventListener('pointerdown', (e) => {
      const col = e.target.closest('.eq-col'); if (!col) return;
      dragging = col; apply(col, e.clientY); e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => { if (dragging) apply(dragging, e.clientY); });
    window.addEventListener('pointerup', () => { dragging = null; });
    renderEq();
  }
  $('btnEqFlat').addEventListener('click', () => {
    rxCalib.eq = null; renderEq();
    $('eqTip').textContent = 'drag a bar to boost / cut a tone';
    log('EQ reset to flat.', 'info');
  });

  // boot
  buildEq();
  updateEcUI();
  refreshBandTxt();
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) populateInputs();
  log('SPIDERTEC SONIC TRANSFER PROTOCOL // MODEL SS-1200 online.', 'ok');
  log('Awaiting operator input. Stay safe out there. ☢', 'info');
})();
