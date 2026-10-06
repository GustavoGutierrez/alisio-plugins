import type { PngCodec } from "../../application/ports/png-codec.js";
import { composeEvidence, cropEvidence } from "./composite.js";
import { decodePng } from "./decode.js";
import { encodePng } from "./encode.js";

/** The in-house codec as the `PngCodec` port. */
export const nodePngCodec: PngCodec = {
  decode: decodePng,
  encode: encodePng,
  composeEvidence,
  crop: cropEvidence,
};
