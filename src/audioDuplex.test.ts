// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

// (13/12/2026) HALF-DUPLEX thich nghi — kiem tra thuan so hoc (khong can thiet bi):
//   (a) chi co `up` (dien thoai noi)          -> `down` bi giam 20 dB, `up` NGUYEN byte;
//   (b) chi co `down` (tieng trong phong)     -> `up` bi giam 12 dB;
//   (c) ca hai im lang (< -60 dBFS)           -> KHONG doi mau nao, gain khong doi;
//   (d) chuyen trang thai MEM (attack 10 ms / release 250 ms, noi tuyen tung mau trong khung) — khong "bat/tat";
//   (e) CCR_CALL_HALFDUPLEX=0                 -> passthrough Y NGUYEN byte;
//   (f) do dai goi KHONG doi (320 / 640 / 642 byte, duoi le giu nguyen);
//   + nguong -34 dBFS, uu the 6 dB, "cu" 500 ms, trang thai rieng tung cuoc goi.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHalfDuplex, decideTarget, DUPLEX_ATTACK_MS, DUPLEX_DOMINANCE_DB, DUPLEX_DOWN_ATTEN_DB, DUPLEX_RELEASE_MS,
  DUPLEX_SILENCE_DBFS, DUPLEX_STALE_MS, DUPLEX_THRESHOLD_DBFS, DUPLEX_UP_ATTEN_DB, HALFDUPLEX_ENABLED, levelDbOf,
  type DuplexDir, type HalfDuplex,
} from './audioDuplex.js';

const RATE = 16000;
/** Mot khung 20 ms (320 mau) hinh sin `hz`, dinh = `dbfs`. */
function sineFrame(dbfs: number, hz = 1000, offset = 0, samples = 320): Buffer {
  const amp = 32767 * 10 ** (dbfs / 20);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * (i + offset) / RATE) * amp), i * 2);
  }
  return b;
}
/** Muc giam thuc te (dB, duong) giua dau vao va dau ra — do bang RMS. */
const attenDb = (input: Buffer, output: Buffer): number => levelDbOf(input) - levelDbOf(output);
/**
 * Day `n` khung cua cung mot tin hieu vao chieu `dir` (moi khung la mot BAN SAO — nhu goi WS that) va tra ve khung
 * CUOI da xu ly. `gain` cua mot chieu chi tien khi chinh chieu do co khung, nen phai day nhieu khung moi on dinh.
 */
function feed(d: HalfDuplex, id: string, dir: DuplexDir, frame: Buffer, n: number): { out: Buffer; in: Buffer } {
  let out = frame;
  for (let i = 0; i < n; i++) out = d.apply(id, dir, Buffer.from(frame));
  return { out, in: frame };
}
/** Khung co bien do KHONG doi (de nhin thay duong ramp gain trong mot khung). */
const flatFrame = (amp: number): Buffer => {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(amp, i * 2);
  return b;
};

describe('audioDuplex — (a) chi co tieng `up`: cat `down` 20 dB, `up` nguyen ven', () => {
  it('`up` -20 dBFS -> `down` bi giam ~20 dB, gain `up` = 0, byte `up` khong doi', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-20);
    for (let i = 0; i < 50; i++) expect(d.apply('p4-a', 'up', Buffer.from(up)).equals(up)).toBe(true);
    expect(d.state('p4-a').upGainDb).toBe(0);            // chieu `up` KHONG bi dung vao
    expect(d.state('p4-a').downGainDb).toBe(0);          // chua co khung `down` nao -> chua giam gi

    const { out, in: src } = feed(d, 'p4-a', 'down', sineFrame(-40), 50);
    expect(out.length).toBe(src.length);
    expect(out.equals(src)).toBe(false);                 // co bi giam
    expect(attenDb(src, out)).toBeCloseTo(DUPLEX_DOWN_ATTEN_DB, 1);
    expect(d.state('p4-a').downGainDb).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB, 1);
    expect(d.state('p4-a').last?.targetDb).toBe(-DUPLEX_DOWN_ATTEN_DB);
    expect(d.state('p4-a').last?.silent).toBe(false);
  });

  it('hang so: nguong -34 dBFS / uu the 6 dB / muc giam 20 & 12 dB / attack 10 ms / release 250 ms', () => {
    expect(DUPLEX_THRESHOLD_DBFS).toBe(-34);
    expect(DUPLEX_DOMINANCE_DB).toBe(6);
    expect(DUPLEX_DOWN_ATTEN_DB).toBe(20);
    expect(DUPLEX_UP_ATTEN_DB).toBe(12);
    expect(DUPLEX_ATTACK_MS).toBe(10);
    expect(DUPLEX_RELEASE_MS).toBe(250);
    expect(DUPLEX_STALE_MS).toBeGreaterThan(DUPLEX_RELEASE_MS);   // "cu" phai dai hon release, neu khong se nhap nhay
  });
});

describe('audioDuplex — (b) chi co tieng `down`: cat `up` 12 dB', () => {
  it('`down` -20 dBFS -> `up` bi giam ~12 dB, `down` khong doi', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const down = sineFrame(-20);
    for (let i = 0; i < 50; i++) expect(d.apply('p4-b', 'down', Buffer.from(down)).equals(down)).toBe(true);
    expect(d.state('p4-b').downGainDb).toBe(0);          // chieu `down` KHONG bi dung vao

    const { out, in: src } = feed(d, 'p4-b', 'up', sineFrame(-40), 50);
    expect(out.length).toBe(src.length);
    expect(attenDb(src, out)).toBeCloseTo(DUPLEX_UP_ATTEN_DB, 1);
    expect(d.state('p4-b').upGainDb).toBeCloseTo(-DUPLEX_UP_ATTEN_DB, 1);
    expect(d.state('p4-b').last?.targetDb).toBe(-DUPLEX_UP_ATTEN_DB);
  });

  it('`up` duoi nguong -34 dBFS hoac khong hon 6 dB -> KHONG cat `down`', () => {
    expect(decideTarget('down', -40, -120)).toBe(0);     // up duoi nguong hoat dong
    expect(decideTarget('down', -36, -120)).toBe(0);     // van duoi nguong
    expect(decideTarget('down', -25, -28)).toBe(0);      // tren nguong nhung chi hon 3 dB
    expect(decideTarget('down', -22, -120)).toBe(-DUPLEX_DOWN_ATTEN_DB);
    expect(decideTarget('up', -120, -55)).toBe(0);       // phong im lang ~ -55 dBFS: KHONG cat `up`
    expect(decideTarget('up', -30, -20)).toBe(-DUPLEX_UP_ATTEN_DB);
  });
});

describe('audioDuplex — (c) ca hai im lang: khong doi mau nao', () => {
  it('so 0 va nhieu nen -80 dBFS -> nguyen byte, gain giu 0', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const zero = Buffer.alloc(640);
    expect(d.apply('p4-c', 'up', zero)).toBe(zero);                 // dung buffer dau vao, khong copy
    expect(d.apply('p4-c', 'down', zero)).toBe(zero);
    const low = sineFrame(-80);
    expect(d.apply('p4-c', 'down', Buffer.from(low)).equals(low)).toBe(true);
    expect(d.state('p4-c').upGainDb).toBe(0);
    expect(d.state('p4-c').downGainDb).toBe(0);
    expect(d.state('p4-c').last?.silent).toBe(true);
    expect(DUPLEX_SILENCE_DBFS).toBe(-60);
  });

  it('dang bi cat ma CA HAI im lang -> giu nguyen gain (khong "mo" dot ngot), mau van nguyen', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-20);
    for (let i = 0; i < 50; i++) d.apply('p4-c2', 'up', Buffer.from(up));
    for (let i = 0; i < 50; i++) d.apply('p4-c2', 'down', sineFrame(-30));
    const ducked = d.state('p4-c2').downGainDb;
    expect(ducked).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB, 1);

    const silence = Buffer.alloc(640);                               // ca hai chieu < -60 dBFS
    d.apply('p4-c2', 'up', silence);
    expect(d.apply('p4-c2', 'down', silence)).toBe(silence);          // khong dung vao mau, khong copy
    expect(d.state('p4-c2').downGainDb).toBe(ducked);                 // gain giu nguyen trong im lang
    expect(d.state('p4-c2').last?.silent).toBe(true);
  });
});

describe('audioDuplex — (d) chuyen trang thai MEM: attack/release, khong "bat/tat"', () => {
  const oneFrameAttack = 1 - Math.exp(-20 / DUPLEX_ATTACK_MS);        // khung 20 ms / tau 10 ms = 86,5%
  const oneFrameRelease = 1 - Math.exp(-20 / DUPLEX_RELEASE_MS);      // khung 20 ms / tau 250 ms = 7,7%

  it(`attack ${DUPLEX_ATTACK_MS} ms: mot khung chi di ~86% quang duong, khong nhay thang -20 dB`, () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 10; i++) d.apply('p4-d', 'up', Buffer.from(up));
    d.apply('p4-d', 'down', sineFrame(-30));                          // khung `down` DAU TIEN
    const g1 = d.state('p4-d').downGainDb;
    expect(g1).toBeLessThan(0);
    expect(g1).toBeGreaterThan(-DUPLEX_DOWN_ATTEN_DB);                // KHONG nhay thang -20
    expect(g1).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB * oneFrameAttack, 1);
    // Khung thu 2 di tiep phan con lai — moi khung mot buoc nho, khong phai 0 -> -20.
    d.apply('p4-d', 'down', sineFrame(-30));
    const g2 = d.state('p4-d').downGainDb;
    expect(g2).toBeLessThan(g1);
    expect(g2).toBeGreaterThan(g1 - 4);
  });

  it('trong MOT khung: gain noi tuyen tung mau (khong co buoc nhay o bien khung -> khong "cup")', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 10; i++) d.apply('p4-d2', 'up', Buffer.from(up));
    const out = d.apply('p4-d2', 'down', flatFrame(1200));            // bien do KHONG doi -> dau ra = duong ramp gain
    expect(out.readInt16LE(0)).toBe(1200);                            // mau dau: chua giam (gain vao = 0 dB)
    const last = out.readInt16LE(318 * 2);
    expect(last).toBeLessThan(out.readInt16LE(0));
    let prev = out.readInt16LE(0);
    for (let i = 1; i < 320; i++) {
      const v = out.readInt16LE(i * 2);
      expect(v).toBeLessThanOrEqual(prev);                            // giam don dieu, khong giat
      prev = v;
    }
    expect(last).toBeGreaterThan(0);                                  // van con tieng (chi giam ~17 dB)
  });

  it(`release ${DUPLEX_RELEASE_MS} ms: sau khi het tieng "up", mot khung chi nha ~7,7%`, () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 50; i++) d.apply('p4-d3', 'up', Buffer.from(up));
    for (let i = 0; i < 50; i++) d.apply('p4-d3', 'down', sineFrame(-30));
    const ducked = d.state('p4-d3').downGainDb;
    expect(ducked).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB, 1);
    // `up` tat (khung im lang) nhung `down` van con tieng -> khong roi vao nhanh "ca hai im lang".
    d.apply('p4-d3', 'up', Buffer.alloc(640));
    d.apply('p4-d3', 'down', sineFrame(-30));
    const released = d.state('p4-d3').downGainDb;
    expect(released).toBeGreaterThan(ducked);                         // nha ra
    expect(released).toBeCloseTo(ducked + DUPLEX_DOWN_ATTEN_DB * oneFrameRelease, 1);   // nhung rat cham
  });

  it(`het tieng "up" > ${DUPLEX_STALE_MS} ms (khong con khung) -> nha ra hoan toan`, () => {
    let t = 0;
    const d = createHalfDuplex({ enabled: true, log: false, now: () => t });
    const up = sineFrame(-14);
    for (let i = 0; i < 50; i++) {
      d.apply('p4-d4', 'up', Buffer.from(up)); t += 20;
      d.apply('p4-d4', 'down', sineFrame(-30)); t += 20;
    }
    expect(d.state('p4-d4').downGainDb).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB, 1);
    t += DUPLEX_STALE_MS + 20;                                        // dien thoai ngung gui khung
    for (let i = 0; i < 80; i++) { d.apply('p4-d4', 'down', sineFrame(-30)); t += 20; }
    expect(d.state('p4-d4').downGainDb).toBe(0);
  });
});

describe('audioDuplex — (e) TAT bang env CCR_CALL_HALFDUPLEX: passthrough y nguyen byte (A/B)', () => {
  const saved = process.env.CCR_CALL_HALFDUPLEX;
  afterEach(() => {
    if (saved === undefined) delete process.env.CCR_CALL_HALFDUPLEX;
    else process.env.CCR_CALL_HALFDUPLEX = saved;
  });

  it('mac dinh BAT (HALFDUPLEX_ENABLED = true khi khong dat env)', () => {
    expect(HALFDUPLEX_ENABLED).toBe(true);
  });

  it('createHalfDuplex({enabled:false}) -> khong sua byte nao, khong tao trang thai', () => {
    const d = createHalfDuplex({ enabled: false, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 50; i++) d.apply('p4-e', 'up', Buffer.from(up));
    const down = sineFrame(-30);
    expect(d.apply('p4-e', 'down', Buffer.from(down)).equals(down)).toBe(true);
    expect(d.size).toBe(0);
  });

  it('CCR_CALL_HALFDUPLEX=0 doc MOT lan luc khoi dong -> HALFDUPLEX_ENABLED = false', async () => {
    vi.resetModules();
    process.env.CCR_CALL_HALFDUPLEX = '0';
    const off = await import('./audioDuplex.js');
    expect(off.HALFDUPLEX_ENABLED).toBe(false);
    const up = sineFrame(-14);
    for (let i = 0; i < 50; i++) off.duplex.apply('p4-e2', 'up', up);
    const down = sineFrame(-30);
    expect(off.duplex.apply('p4-e2', 'down', down)).toBe(down);       // dung buffer dau vao, nguyen byte

    vi.resetModules();
    delete process.env.CCR_CALL_HALFDUPLEX;
    const on = await import('./audioDuplex.js');
    expect(on.HALFDUPLEX_ENABLED).toBe(true);
  });
});

describe('audioDuplex — (f) do dai goi khong doi', () => {
  it('320 / 640 / 642 byte: dung so byte, duoi le giu nguyen', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 10; i++) d.apply('p4-f', 'up', Buffer.from(up));
    for (const bytes of [320, 640, 642]) {
      const src = Buffer.concat([sineFrame(-30, 1000, 0, Math.ceil(bytes / 2)), Buffer.from([1, 2])]).subarray(0, bytes);
      const out = d.apply('p4-f', 'down', Buffer.from(src));
      expect(out.length).toBe(src.length);
      if (bytes & 1) expect(out[out.length - 1]).toBe(src[src.length - 1]);
    }
  });

  it('goi 10 ms (320 byte): hang so thoi gian tinh theo do dai THAT cua khung', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 10; i++) d.apply('p4-f2', 'up', Buffer.from(up));
    d.apply('p4-f2', 'down', sineFrame(-30, 1000, 0, 160));           // 160 mau = 10 ms
    // attack 10 ms tren khung 10 ms -> 1 - e^-1 = 63,2% cua 20 dB = ~12,6 dB.
    expect(d.state('p4-f2').downGainDb).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB * (1 - Math.exp(-1)), 0);
  });
});

describe('audioDuplex — trang thai RIENG cho tung cuoc goi', () => {
  it('hai cuoc goi khong lan trang thai; forget() xoa sach', () => {
    const d = createHalfDuplex({ enabled: true, log: false });
    const up = sineFrame(-14);
    for (let i = 0; i < 50; i++) d.apply('call-1', 'up', Buffer.from(up));
    for (let i = 0; i < 50; i++) d.apply('call-1', 'down', sineFrame(-30));
    expect(d.state('call-1').downGainDb).toBeCloseTo(-DUPLEX_DOWN_ATTEN_DB, 1);
    // Cuoc goi khac: im lang -> khong bi cuoc goi 1 lam "cam".
    const otherDown = sineFrame(-30);
    expect(d.apply('call-2', 'down', Buffer.from(otherDown)).equals(otherDown)).toBe(true);
    expect(d.state('call-2').downGainDb).toBe(0);
    d.forget('call-1');
    expect(d.peek('call-1')).toBeUndefined();
    expect(d.size).toBe(1);
    d.reset();
    expect(d.size).toBe(0);
  });
});
