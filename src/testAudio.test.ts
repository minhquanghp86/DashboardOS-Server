// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (05/12/2026) BO PHAT THU NGHIEM — phan THUAN cua src/testAudio.ts, kiem tra khong can thiet bi:
//   - doc WAV: dung 16 kHz/mono/s16le, dai 10 s, RMS -20 dBFS, dinh <= -6 dBFS (3 tep mau trong test-audio/);
//   - tu choi tep sai dinh dang (48 kHz, stereo, 8-bit, khong phai PCM) — khong gui bua xuong loa;
//   - ten tep an toan (khong cho `../`, khong cho duong dan tuyet doi);
//   - nhip phat 20 ms/khung theo MOC TUYET DOI (dong ho gia): khong drift, khong bun no, co `lateTicks`;
//   - CHUOI THAT (EQ -> AGC/limiter, dung nhu `sendToSpeaker`): tep mau di qua khong bi meo, khong tran dinh
//     — day la bang chung dinh luong cho cau hoi "co nen bat AGC/limiter muc -26/-4 dBFS hay khong".
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGC_MAX_GAIN_DB, AGC_TARGET_DBFS, LIMIT_DBFS, newAgcState, peakOf, processPcm, rmsDbOf,
} from './audioAgc.js';
import { HALFDUPLEX_ENABLED } from './audioDuplex.js';
import { eqApply, newEqState } from './callEq.js';
import {
  FRAME_BYTES as TA_FRAME_BYTES, frameCount, listTestAudio, loadTestAudio, parseWav, playPaced, readPlayParams,
  sanitizeName, testAudioDirCandidates,
} from './testAudio.js';

const DIR = path.join(process.cwd(), 'test-audio');
const FILES = ['speech-like.wav', 'tone-1k.wav', 'noise.wav'];
/** Thu muc doc theo alphabet (listTestAudio sap xep theo ten tep trong thu muc). */
const FILES_SORTED = [...FILES].sort();

const rmsOf = (pcm: Buffer): number => {
  const n = pcm.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
};
const peakOfPcm = (pcm: Buffer): number => {
  let p = 0;
  for (let i = 0; i < pcm.length; i += 2) { const a = Math.abs(pcm.readInt16LE(i)); if (a > p) p = a; }
  return p;
};
const dbfs = (x: number): number => 20 * Math.log10(x || 1e-12);

/** Bien do thanh phan `hz` (Goertzel) / tong nang luong -> THD (%). */
function thdPct(pcm: Buffer, hz: number): number {
  const n = pcm.length / 2;
  const k = 2 * Math.cos((2 * Math.PI * hz) / 16000);
  let s1 = 0, s2 = 0, e = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    const s0 = v + k * s1 - s2; s2 = s1; s1 = s0;
    e += v * v;
  }
  const amp = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * 2 / n;
  const fund = (amp * amp) / 2;
  const total = e / n;
  return 100 * Math.sqrt(Math.max(0, total - fund) / Math.max(fund, 1e-12));
}

/** Chay PCM qua dung chuoi xuong loa: EQ (neu bat) -> AGC/limiter, tung khung 640 byte. */
function throughChain(pcm: Buffer, opts: { eq: boolean; agc: boolean }): Buffer {
  const agcState = newAgcState();
  const eqState = newEqState();
  const out = Buffer.alloc(pcm.length);
  for (let o = 0; o + 2 <= pcm.length; o += TA_FRAME_BYTES) {
    const end = Math.min(pcm.length, o + TA_FRAME_BYTES);
    let f: Buffer = Buffer.from(pcm.subarray(o, end));
    if (opts.eq) f = eqApply(eqState, f, true);
    if (opts.agc) f = processPcm(f, agcState);
    f.copy(out, o);
  }
  return out;
}

describe('testAudio — doc WAV (3 tep mau da commit)', () => {
  it('ca 3 tep: 16 kHz, mono, 16-bit, 10,000 s, RMS -20 dBFS, dinh <= -6 dBFS', () => {
    expect(fs.existsSync(DIR)).toBe(true);
    for (const name of FILES) {
      const buf = fs.readFileSync(path.join(DIR, name));
      const w = parseWav(buf);
      expect(w.sampleRate).toBe(16000);
      expect(w.channels).toBe(1);
      expect(w.bitsPerSample).toBe(16);
      expect(w.samples).toBe(160000);                     // 10 s
      expect(w.ms).toBe(10000);
      expect(w.data.length).toBe(320000);                  // = 500 khung 20 ms
      expect(frameCount(w.data.length)).toBe(500);
      expect(dbfs(rmsOf(w.data))).toBeCloseTo(-20, 0);     // chuan hoa RMS
      expect(dbfs(peakOfPcm(w.data) / 32768)).toBeLessThanOrEqual(-6);   // tran dinh
    }
  });

  it('speech-like: co khoang lang giua cac am tiet (125 khung im lang = 25 am tiet x 100 ms)', () => {
    const { wav } = loadTestAudio('speech-like.wav', fs, [DIR]);
    let silent = 0;
    for (let o = 0; o + TA_FRAME_BYTES <= wav.data.length; o += TA_FRAME_BYTES) {
      if (rmsDbOf(wav.data.subarray(o, o + TA_FRAME_BYTES)) < -60) silent++;
    }
    expect(silent).toBe(125);
  });

  it('tone-1k: dung 1 kHz, phang (moi khung 20 ms cung muc -20 dBFS)', () => {
    const { wav } = loadTestAudio('tone-1k.wav', fs, [DIR]);
    for (let o = 0; o + TA_FRAME_BYTES <= wav.data.length; o += TA_FRAME_BYTES) {
      expect(rmsDbOf(wav.data.subarray(o, o + TA_FRAME_BYTES))).toBeCloseTo(-20, 1);
    }
    expect(thdPct(wav.data, 1000)).toBeLessThan(0.5);      // sin sach
  });

  it('noise: nhieu hong muc thap, khong co khung im lang nao (do "bi cat khoang lang")', () => {
    const { wav } = loadTestAudio('noise.wav', fs, [DIR]);
    let quiet = 0;
    for (let o = 0; o + TA_FRAME_BYTES <= wav.data.length; o += TA_FRAME_BYTES) {
      if (rmsDbOf(wav.data.subarray(o, o + TA_FRAME_BYTES)) < -40) quiet++;
    }
    expect(quiet).toBe(0);
  });
});

describe('testAudio — tu choi tep sai dinh dang', () => {
  const good = (): Buffer => {
    const b = Buffer.alloc(44 + 640);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + 640, 4); b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'latin1'); b.writeUInt32LE(640, 40);
    return b;
  };

  it('tep hop le -> doc duoc', () => {
    expect(parseWav(good()).samples).toBe(320);
  });

  it('qua ngan / khong phai RIFF / thieu data -> loi', () => {
    expect(() => parseWav(Buffer.alloc(10))).toThrow(/qua ngan/);
    const notRiff = good(); notRiff.write('XXXX', 0, 'latin1');
    expect(() => parseWav(notRiff)).toThrow(/khong phai tep WAV/);
    const noData = good(); noData.write('junk', 36, 'latin1');
    expect(() => parseWav(noData.subarray(0, 44))).toThrow(/thieu chunk "data"/);
  });

  it('48 kHz / stereo / 8-bit / khong phai PCM -> loi co ly do', () => {
    const rate = good(); rate.writeUInt32LE(48000, 24);
    expect(() => parseWav(rate)).toThrow(/48000 Hz/);
    const st = good(); st.writeUInt16LE(2, 22);
    expect(() => parseWav(st)).toThrow(/2 kenh/);
    const bits = good(); bits.writeUInt16LE(8, 34);
    expect(() => parseWav(bits)).toThrow(/8-bit/);
    const flt = good(); flt.writeUInt16LE(3, 20);
    expect(() => parseWav(flt)).toThrow(/PCM/);
  });

  it('chunk la (size le) khong lam lech con tro doc', () => {
    const b = good();
    const odd = Buffer.concat([
      b.subarray(0, 36),
      Buffer.from('LIST', 'latin1'), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0]),   // size=3 -> dem 1 byte
      b.subarray(36),
    ]);
    const w = parseWav(odd);
    expect(w.samples).toBe(320);
  });
});

describe('testAudio — ten tep va danh sach', () => {
  it('sanitizeName: chi ten.wav, khong duong dan', () => {
    expect(sanitizeName('tone-1k.wav')).toBe('tone-1k.wav');
    expect(sanitizeName('speech-like.wav')).toBe('speech-like.wav');
    expect(sanitizeName('../secret.wav')).toBeNull();
    expect(sanitizeName('a/b.wav')).toBeNull();
    expect(sanitizeName('/etc/passwd')).toBeNull();
    expect(sanitizeName('tone.mp3')).toBeNull();
    expect(sanitizeName('')).toBeNull();
    expect(sanitizeName('x'.repeat(80) + '.wav')).toBeNull();
  });

  it('sanitizeName: thieu .wav thi TU THEM (file=speech-like), van chan duong dan/duoi la', () => {
    expect(sanitizeName('speech-like')).toBe('speech-like.wav');
    expect(sanitizeName('  speech-like  ')).toBe('speech-like.wav');      // khoang trang bi cat
    expect(sanitizeName('tone-1k')).toBe('tone-1k.wav');
    expect(sanitizeName('noise')).toBe('noise.wav');
    expect(sanitizeName('speech-like.WAV')).toBe('speech-like.wav');      // duoi hoa -> chu thuong
    expect(sanitizeName('speech-like.wav')).toBe('speech-like.wav');      // da co .wav -> giu nguyen
    expect(sanitizeName('speech-like.mp3')).toBeNull();                   // KHONG thanh speech-like.mp3.wav
    expect(sanitizeName('../etc/passwd')).toBeNull();                     // khong tu them roi lot ra ngoai
    expect(sanitizeName('/app/test-audio/noise')).toBeNull();
    expect(sanitizeName('a b')).toBeNull();                               // khoang trang ben trong: khong hop le
    expect(sanitizeName('x'.repeat(70))).toBeNull();                      // qua dai sau khi them .wav
  });

  it('testAudioDirCandidates: co ca duong dev (<cwd>/test-audio) va container (/app/test-audio)', () => {
    const dirs = testAudioDirCandidates({});
    expect(dirs[0]).toBe(path.resolve(process.cwd(), 'test-audio'));     // dev: goc repo
    expect(dirs).toContain('/app/test-audio');                            // container HA add-on (WORKDIR /app)
    expect(dirs).toContain(path.resolve(process.cwd(), 'test-audio'));     // node dist/index.js tai goc repo
    expect(dirs.every((d) => path.isAbsolute(d))).toBe(true);
    expect(new Set(dirs).size).toBe(dirs.length);                         // khong trung
    // Chay tu dist/ (node dist/index.js): <module>/../test-audio phai co mat.
    const modDir = path.dirname(path.resolve(process.cwd(), 'src', 'testAudio.ts'));
    expect(dirs).toContain(path.resolve(modDir, '..', 'test-audio'));
    // CCR_TEST_AUDIO_DIR ghi de hoan toan (dung trong test va khi thu muc nam cho khac).
    expect(testAudioDirCandidates({ CCR_TEST_AUDIO_DIR: '/tmp/x' })).toEqual(['/tmp/x']);
    expect(testAudioDirCandidates({ CCR_TEST_AUDIO_DIR: '  ' })[0]).toBe(dirs[0]);
  });

  it('listTestAudio: thay dung 3 tep, moi tep 10 s', () => {
    const list = listTestAudio(fs, [DIR]);
    expect(list.map((f) => f.name)).toEqual(FILES_SORTED);
    expect(list.every((f) => f.ms === 10000)).toBe(true);
    expect(list.every((f) => f.bytes === 320044)).toBe(true);
  });

  it('listTestAudio: khong truyen dirs -> tu tim thay test-audio/ cua repo (duong dung trong image)', () => {
    const list = listTestAudio(fs);                                       // testAudioDirCandidates() that
    expect(list.map((f) => f.name)).toEqual(FILES_SORTED);
    expect(list.every((f) => f.ms === 10000)).toBe(true);
  });

  it('loadTestAudio: ten sai -> loi; thu muc khong ton tai -> loi ro rang', () => {
    expect(() => loadTestAudio('../x.wav', fs, [DIR])).toThrow(/khong hop le/);
    expect(() => loadTestAudio('khong-co.wav', fs, [DIR])).toThrow(/khong co tep/);
    // Thong diep phai chi ra da tim o dau va dang co tep nao (chan doan "image thieu test-audio/").
    expect(() => loadTestAudio('khong-co.wav', fs, [DIR])).toThrow(/da tim: .*test-audio/);
    expect(() => loadTestAudio('khong-co.wav', fs, [DIR])).toThrow(/dang co: .*speech-like\.wav/);
  });

  it('loadTestAudio: goi KHONG co .wav van doc dung tep -> 500 khung 20 ms (10 s)', () => {
    const { name, wav } = loadTestAudio('speech-like', fs, [DIR]);        // file=speech-like (thieu .wav)
    expect(name).toBe('speech-like.wav');
    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect(wav.samples).toBe(160000);
    expect(wav.data.length).toBe(320000);
    expect(frameCount(wav.data.length)).toBe(500);
  });
});

describe('testAudio — tham so /call/test/play', () => {
  const q = (s: string) => (k: string) => new URL(`http://x/?${s}`).searchParams.get(k);

  it('mac dinh: speech-like.wav, loop 1, gain 0, agc/eq theo env (undefined)', () => {
    expect(readPlayParams(q(''))).toEqual({ file: 'speech-like.wav', loop: 1, agc: undefined, eq: undefined, gainDb: 0 });
  });

  it('doc day du: file, loop, agc, eq, gain', () => {
    expect(readPlayParams(q('file=tone-1k.wav&loop=3&agc=0&eq=1&gain=-6')))
      .toEqual({ file: 'tone-1k.wav', loop: 3, agc: false, eq: true, gainDb: -6 });
    expect(readPlayParams(q('agc=1&eq=0')).agc).toBe(true);
    expect(readPlayParams(q('agc=1&eq=0')).eq).toBe(false);
  });

  it('file= thieu .wav -> tu them: speech-like va speech-like.wav la MOT', () => {
    expect(readPlayParams(q('file=speech-like')).file).toBe('speech-like.wav');
    expect(readPlayParams(q('file=speech-like.wav')).file).toBe('speech-like.wav');
    expect(readPlayParams(q('file=speech-like&loop=2')).file).toBe('speech-like.wav');
    expect(readPlayParams(q('file=tone-1k')).file).toBe('tone-1k.wav');
    expect(readPlayParams(q('file=noise')).file).toBe('noise.wav');
    // Ten la: giu nguyen van de loadTestAudio bao loi "khong hop le" (400), khong lang le doi tep khac.
    expect(readPlayParams(q('file=../etc/passwd')).file).toBe('../etc/passwd');
    expect(readPlayParams(q('file=tone.mp3')).file).toBe('tone.mp3');
    expect(readPlayParams(q('file=')).file).toBe('speech-like.wav');       // rong -> mac dinh
    expect(readPlayParams(q('file=%20%20')).file).toBe('speech-like.wav'); // chi khoang trang -> mac dinh
  });

  it('gia tri sai -> kep ve khoang hop le, khong nem loi', () => {
    expect(readPlayParams(q('loop=0')).loop).toBe(1);
    expect(readPlayParams(q('loop=99999')).loop).toBe(600);
    expect(readPlayParams(q('loop=abc')).loop).toBe(1);
    expect(readPlayParams(q('gain=+99')).gainDb).toBe(20);
    expect(readPlayParams(q('gain=-99')).gainDb).toBe(-40);
    expect(readPlayParams(q('agc=khong-hieu')).agc).toBeUndefined();
  });
});

// ── Nhip phat: dong ho gia ───────────────────────────────────────────────────────────────────────────────────────
interface Sent { at: number; bytes: number }

function fakeClock(): {
  sent: Sent[]; run: (pcm: Buffer, loop: number, opts?: { maxCatchUp?: number; stallAt?: number; stallMs?: number }) => { at: number; bytes: number }[];
  play: (pcm: Buffer, loop: number, opts?: { maxCatchUp?: number }) => Promise<{ frames: number; lateTicks: number }>;
} {
  let t = 0;
  let sent: Sent[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const setT = (fn: () => void, ms: number): unknown => { const id = { at: t + ms, fn }; timers.push(id); return id; };
  const clearT = (id: unknown): void => { const i = timers.indexOf(id as { at: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); };
  const advanceTo = (end: number): void => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers[0];
      if (!n || n.at > end) break;
      timers.shift(); t = n.at; n.fn();
    }
    t = end;
  };
  return {
    get sent() { return sent; },
    run(pcm, loop, opts = {}) {
      sent = [];
      const p = playPaced({ pcm, loop, maxCatchUp: opts.maxCatchUp, send: (f) => sent.push({ at: t, bytes: f.length }), now: () => t, setTimeout: setT, clearTimeout: clearT });
      advanceTo(10_000_000);                                // chay het hen gio
      void p;
      return sent;
    },
    async play(pcm, loop, opts = {}) {
      sent = [];
      const p = playPaced({ pcm, loop, maxCatchUp: opts.maxCatchUp, send: (f) => sent.push({ at: t, bytes: f.length }), now: () => t, setTimeout: setT, clearTimeout: clearT });
      advanceTo(1_000_000);
      return p;
    },
  };
}

describe('testAudio — nhip phat 20 ms (moc tuyet doi)', () => {
  const pcm = Buffer.alloc(TA_FRAME_BYTES * 5, 3);      // 5 khung 20 ms

  it('5 khung -> gui tai 0, 20, 40, 60, 80 ms (dung 20 ms/khung)', () => {
    const c = fakeClock();
    const sent = c.run(pcm, 1);
    expect(sent.map((s) => s.at)).toEqual([0, 20, 40, 60, 80]);
    expect(sent.every((s) => s.bytes === TA_FRAME_BYTES)).toBe(true);
  });

  it('loop=3 -> 15 khung, nhip van 20 ms va lap lai noi dung tep', () => {
    const c = fakeClock();
    const sent = c.run(pcm, 3);
    expect(sent.length).toBe(15);
    expect(sent.map((s) => s.at)).toEqual(Array.from({ length: 15 }, (_, k) => k * 20));
  });

  it('tep le (khong chia het 20 ms) -> khung cuoi ngan hon, khong mat mau', () => {
    const c = fakeClock();
    const odd = Buffer.alloc(TA_FRAME_BYTES + 100, 1);   // 1 khung + 50 mau
    const sent = c.run(odd, 1);
    expect(sent.map((s) => s.bytes)).toEqual([TA_FRAME_BYTES, 100]);
  });

  it('event loop bi chan 100 ms -> bu toi da maxCatchUp khung moi nhip, co dem `lateTicks`', async () => {
    let t = 0;
    const sent: Sent[] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const setT = (fn: () => void, ms: number): unknown => { const id = { at: t + ms, fn }; timers.push(id); return id; };
    const p = playPaced({
      pcm: Buffer.alloc(TA_FRAME_BYTES * 10, 1), loop: 1, maxCatchUp: 2,
      send: (f) => sent.push({ at: t, bytes: f.length }),
      now: () => t, setTimeout: setT, clearTimeout: (id) => { const i = timers.indexOf(id as { at: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    // Nhip dau chay ngay (t = 0), sau do "may bi tre" 100 ms truoc khi hen gio ke tiep chay.
    t = 100;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers.shift();
      if (!n) break;
      t = Math.max(t, n.at);
      n.fn();
      if (sent.length > 40) break;
    }
    const r = await p;
    expect(r.frames).toBe(10);
    expect(r.lateTicks).toBeGreaterThanOrEqual(1);        // co ghi nhan tre
    const perTick = new Map<number, number>();
    for (const s of sent) perTick.set(s.at, (perTick.get(s.at) ?? 0) + 1);
    expect(Math.max(...perTick.values())).toBeLessThanOrEqual(2);   // khong xa > 2 khung mot luc
  });

  it('signal.aborted -> dung som', async () => {
    const c = fakeClock();
    const signal = { aborted: true };
    const r = await playPaced({ pcm, loop: 5, send: () => { }, signal, now: () => 0, setTimeout: () => null, clearTimeout: () => { } });
    expect(r.frames).toBe(0);
    void c;
  });
});

// ── Bang chung dinh luong: tep mau di qua chuoi that co bi meo khong ────────────────────────────────────────────
describe('testAudio — chuoi EQ -> AGC/limiter tren tep mau (co nen bat AGC khong)', () => {
  it('tone-1k qua chuoi: KHONG meo (THD < 1%) va khong tran dinh — muc nham AGC an toan', () => {
    const { wav } = loadTestAudio('tone-1k.wav', fs, [DIR]);
    for (const eq of [false, true]) {
      const out = throughChain(wav.data, { eq, agc: true });
      expect(dbfs(peakOfPcm(out) / 32768)).toBeLessThanOrEqual(-4);      // duoi tran limiter LIMIT_DBFS
      // Do THD o NUA SAU tep: 1 s dau gain con dang chay tu 0 ve muc nham (do la qua do cua AGC, khong phai meo).
      expect(thdPct(out.subarray(out.length / 2), 1000)).toBeLessThan(1);
    }
    // EQ TAT: AGC dua dung ve AGC_TARGET_DBFS (doc hang so, KHONG viet cung -26 nhu truoc).
    const flat = throughChain(wav.data, { eq: false, agc: true });
    expect(dbfs(rmsOf(flat.subarray(flat.length - TA_FRAME_BYTES * 50)))).toBeCloseTo(AGC_TARGET_DBFS, 0);
    // EQ BAT: presence +4 dB @ 1,5 kHz nang 1 kHz them ~2,3 dB -> AGC chi can it gain hon de ve CUNG muc nham
    // (khong bi chan boi AGC_MIN_GAIN_DB o day) — do do muc ra bang muc nham, van con nhieu dB duoi tran limiter.
    const boosted = throughChain(wav.data, { eq: true, agc: true });
    const tailDb = dbfs(rmsOf(boosted.subarray(boosted.length - TA_FRAME_BYTES * 50)));
    expect(tailDb).toBeCloseTo(AGC_TARGET_DBFS, 0);
    expect(tailDb).toBeLessThan(LIMIT_DBFS - 3);
  });

  it('speech-like qua chuoi: dinh <= -4 dBFS (limiter khong phai cat cung)', () => {
    const { wav } = loadTestAudio('speech-like.wav', fs, [DIR]);
    const out = throughChain(wav.data, { eq: true, agc: true });
    expect(dbfs(peakOfPcm(out) / 32768)).toBeLessThanOrEqual(-4);
    expect(dbfs(rmsOf(out))).toBeGreaterThan(-30);                        // khong bi bop nho
    expect(peakOf(out)).toBeLessThanOrEqual(32767);
  });

  it('noise qua chuoi: AGC lam DEU muc (do lech giua cac khung giam), khong tran dinh', () => {
    const { wav } = loadTestAudio('noise.wav', fs, [DIR]);
    const out = throughChain(wav.data, { eq: false, agc: true });
    /** Do lech muc giua cac khung 20 ms — AGC lam muc deu => do lech giam. */
    const spread = (b: Buffer): number => {
      const v: number[] = [];
      for (let o = 0; o + TA_FRAME_BYTES <= b.length; o += TA_FRAME_BYTES) v.push(rmsDbOf(b.subarray(o, o + TA_FRAME_BYTES)));
      const m = v.reduce((a, x) => a + x, 0) / v.length;
      return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length);
    };
    expect(spread(out)).toBeLessThan(spread(wav.data));                 // deu hon dau vao
    expect(peakOf(out)).toBeLessThanOrEqual(32767);
    expect(dbfs(peakOfPcm(out) / 32768)).toBeLessThanOrEqual(-4);
  });

  it('tep -20 dBFS RMS -> AGC dua ve dung AGC_TARGET_DBFS (khong dung gain toi da)', () => {
    const { wav } = loadTestAudio('tone-1k.wav', fs, [DIR]);
    const out = throughChain(wav.data, { eq: false, agc: true });
    const tail = out.subarray(out.length - TA_FRAME_BYTES * 50);          // 1 s cuoi: gain da on dinh
    const before = dbfs(rmsOf(wav.data));
    expect(dbfs(rmsOf(tail))).toBeCloseTo(AGC_TARGET_DBFS, 0);
    // Gain toi da phu thuoc half-duplex: +24 dB khi BAT (muc nham -14, can keo tieng dien thoai nho len), +12 khi TAT.
    expect(AGC_MAX_GAIN_DB).toBe(HALFDUPLEX_ENABLED ? 24 : 12);
    expect(AGC_MAX_GAIN_DB).toBeGreaterThanOrEqual(Math.abs(AGC_TARGET_DBFS - before));  // khong bi chan gain
    expect(Math.sign(dbfs(rmsOf(tail)) - before)).toBe(Math.sign(AGC_TARGET_DBFS - before));  // ve dung huong
  });
});
