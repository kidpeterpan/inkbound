// Structural guard, registered via vitest.config.ts's `test.setupFiles`, in the
// same spirit as no-network.ts: the real Bases renderer (src/bases-adapter.ts)
// attaches a host to the live document and waits up to five real seconds for
// Obsidian to fill it in. Under vitest there is no Obsidian, so a test that
// embeds a .base file and forgets to inject a renderer would silently spend
// those five seconds and then pass or fail on a timeout it never meant to test.
//
// This installs a stand-in that fails at once, before EVERY test in every file.
// A test that wants a Bases table or a specific failure calls setBaseRenderer
// itself, after this hook has run.
import { beforeEach } from "vitest";
import { setBaseRenderer } from "../../src/adapters/bases-adapter";

beforeEach(() => {
  setBaseRenderer(async () => ({ ok: false, reason: "Bases cannot render outside Obsidian (test default)" }));
});
