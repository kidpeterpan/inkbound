import { describe, it, expect } from "vitest";

describe("harness", () => {
  it("runs with a DOM", () => {
    const el = document.createElement("div");
    el.innerHTML = "<p>ok</p>";
    expect(el.querySelector("p")?.textContent).toBe("ok");
  });
});
