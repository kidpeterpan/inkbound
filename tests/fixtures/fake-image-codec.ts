// A recording stand-in for the browser's image codec.
//
// Structurally compatible with ImageCodec (src/core/epub/image-codec.ts, see
// specs/013-eink-image-optimization/contracts/image-codec.md) but declared here
// on its own, so this helper exists before — and does not import — the module it
// stands in for. TypeScript checks the match wherever a fake is handed to
// createImageOptimizer or setImageCodec.
//
// Every result is scripted: a test says what the codec "decoded" instead of
// running a canvas, which is how the decision logic is tested without one.

export interface FakeCodecRequest {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  maxWidth: number;
  grayscale: boolean;
}

// What resample does for one call:
//   Uint8Array     → resolves with these bytes (the "shrunk" image)
//   null           → resolves null ("nothing to do, already within the width")
//   Error          → rejects with it
//   "never-settles"→ returns a promise that never settles (a hung decode)
//   "throws"       → throws synchronously, before returning a promise
export type FakeCodecResult = Uint8Array | null | Error | "never-settles" | "throws";

export interface FakeImageCodecOptions {
  available?: boolean;
  // Consumed one per resample call, in order; `afterScript` answers every call
  // once the list runs out.
  script?: FakeCodecResult[];
  afterScript?: FakeCodecResult;
}

export interface FakeImageCodec {
  available(): boolean;
  resample(request: FakeCodecRequest): Promise<Uint8Array | null>;
  readonly requests: FakeCodecRequest[];
  availableCalls: number;
}

// One byte: smaller than any real image file, so a test that wants "the codec
// produced something smaller" does not have to build a bigger original.
export const SHRUNK_BYTES = Uint8Array.of(0xaa);

export function fakeImageCodec(options: FakeImageCodecOptions = {}): FakeImageCodec {
  const { available = true, script = [], afterScript = SHRUNK_BYTES } = options;
  const remaining = [...script];
  const requests: FakeCodecRequest[] = [];

  const codec: FakeImageCodec = {
    availableCalls: 0,
    requests,
    available() {
      codec.availableCalls++;
      return available;
    },
    resample(request) {
      requests.push(request);
      const result = remaining.length > 0 ? remaining.shift()! : afterScript;

      if (result === "throws") throw new Error("codec exploded");
      if (result === "never-settles") return new Promise<never>(() => {});
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
  };
  return codec;
}
