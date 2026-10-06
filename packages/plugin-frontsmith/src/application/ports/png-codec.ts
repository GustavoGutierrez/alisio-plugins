import type { PngImage } from "../../domain/fidelity/image.js";

export interface EvidenceComposite {
  image: PngImage;
  png: Uint8Array;
  /** The whole-number reduction applied to every panel. */
  scale: number;
}

export interface EvidenceRequest {
  reference: PngImage;
  actual: PngImage;
  maxWidth: number;
  maxBytes: number;
  channelTolerance: number;
  regions?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
}

/** The in-house PNG codec behind the fidelity pipeline (spec 10.3). Unsupported PNGs throw an error whose `kind` is `unsupported`. */
export interface PngCodec {
  /** A crop of an image as PNG bytes below `maxBytes`, reduced by whole numbers when needed; `undefined` when empty. */
  crop(
    image: PngImage,
    rect: { x: number; y: number; width: number; height: number },
    maxBytes: number,
  ): Uint8Array | undefined;
  decode(bytes: Uint8Array): PngImage;
  encode(image: PngImage): Uint8Array;
  composeEvidence(request: EvidenceRequest): EvidenceComposite;
}
