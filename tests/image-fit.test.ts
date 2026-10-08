import { describe, it, expect } from "vitest";
import { fitWidth } from "../src/core/epub/image-fit";

describe("fitWidth", () => {
  it("scales a wider image down to the maximum width, keeping its proportions", () => {
    expect(fitWidth(3200, 1800, 1200)).toEqual({ width: 1200, height: 675 });
    expect(fitWidth(4000, 3000, 1200)).toEqual({ width: 1200, height: 900 });
  });

  it("rounds the height to the nearest pixel", () => {
    // 1999 * 1200 / 3001 = 799.3…
    expect(fitWidth(3001, 1999, 1200)).toEqual({ width: 1200, height: 799 });
    // 1000 * 1200 / 3001 = 399.8…
    expect(fitWidth(3001, 1000, 1200)).toEqual({ width: 1200, height: 400 });
  });

  it("never returns a side below one pixel", () => {
    expect(fitWidth(5000, 1, 1200)).toEqual({ width: 1200, height: 1 });
  });

  it("leaves an image no wider than the maximum untouched, exactly equal included", () => {
    expect(fitWidth(800, 600, 1200)).toEqual({ width: 800, height: 600 });
    expect(fitWidth(1200, 3000, 1200)).toEqual({ width: 1200, height: 3000 });
  });

  it("never scales up", () => {
    expect(fitWidth(100, 50, 3000)).toEqual({ width: 100, height: 50 });
  });
});
