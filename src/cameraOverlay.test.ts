// SPDX-License-Identifier: Apache-2.0
//
// Copyright (c) 2026 minhquanghp86
// Licensed under the Apache License, Version 2.0 (see LICENSE).

import { describe, expect, it } from "vitest";
import { isFullMedia, overlayPlan, shouldFill } from "./cameraOverlay.js";

describe("overlayPlan — chon nguon hinh cho lop thong bao", () => {
  it("co luong MJPEG thi uu tien luong, poster lam du phong", () => {
    expect(overlayPlan({ str: "s", pst: "p" })).toEqual({ kind: "stream", src: "s", poster: "p" });
  });
  it("chi co anh tinh -> image", () => {
    expect(overlayPlan({ img: "i" })).toEqual({ kind: "image", src: "i" });
  });
  it("rong -> none", () => {
    expect(overlayPlan({})).toEqual({ kind: "none" });
  });
});

describe("isFullMedia", () => {
  it("co hinh -> phu toan man", () => {
    expect(isFullMedia({ str: "s" })).toBe(true);
    expect(isFullMedia({})).toBe(false);
  });
});

describe("shouldFill — man vuong vs camera 16:9 (23/11/2026)", () => {
  it("man vuong 480x480 KHONG tu dong lap kin (giu contain nhu 2.9.330)", () => {
    expect(shouldFill({}, 480, 480, 16 / 9)).toBe(false);
  });
  it("man 1024x600 (1,71) + camera 16:9 -> khong lap kin (lech it)", () => {
    expect(shouldFill({}, 1024, 600, 16 / 9)).toBe(false);
  });
  it("man 480x272 (1,76) + camera 16:9 -> khong lap kin", () => {
    expect(shouldFill({}, 480, 272, 16 / 9)).toBe(false);
  });
  it("fill=true tu automation thang moi ti le", () => {
    expect(shouldFill({ fill: true }, 1024, 600, 16 / 9)).toBe(true);
  });
  it("fill=false tat lap kin ke ca man vuong", () => {
    expect(shouldFill({ fill: false }, 480, 480, 16 / 9)).toBe(false);
  });
});
