// Pure inference helpers shared by the worker: tokenization limits, input tensors, mean pooling and
// L2 normalization. Verified against transformers.js `feature-extraction` (`pooling: "mean"`,
// `normalize: true`, `dtype: "q8"`): cosine 1.000000 on the pinned e5-small (spec §16).

export interface TokenizerLike {
  encode(text: string): { ids: number[] };
}

/** Token ids per text, cut to `maxTokens` while keeping the closing special token. */
export function encodeBatch(tokenizer: TokenizerLike, texts: string[], maxTokens: number) {
  return texts.map((text) => {
    const ids = tokenizer.encode(text).ids;
    if (ids.length <= maxTokens) return ids;
    return [...ids.slice(0, maxTokens - 1), ids[ids.length - 1] as number];
  });
}

/**
 * Row-major padded `int64` inputs. Padding uses the tokenizer's pad id: the q8 graph quantizes
 * activations per tensor, so the pad value affects the numbers of the other rows.
 */
export function batchInputs(encoded: number[][], padId: number) {
  const batch = encoded.length;
  const length = Math.max(1, ...encoded.map((ids) => ids.length));
  const inputIds = new BigInt64Array(batch * length).fill(BigInt(padId));
  const attention = new BigInt64Array(batch * length);
  const tokenTypes = new BigInt64Array(batch * length);
  encoded.forEach((ids, row) => {
    ids.forEach((id, col) => {
      inputIds[row * length + col] = BigInt(id);
      attention[row * length + col] = 1n;
    });
  });
  return { batch, length, inputIds, attention, tokenTypes, lengths: encoded.map((e) => e.length) };
}

/** Mean of the first `lengths[i]` token vectors of each row, scaled to unit length. */
export function meanPoolNormalize(
  hidden: Float32Array,
  dims: readonly number[],
  lengths: number[],
): Float32Array[] {
  const length = dims[1] as number;
  const size = dims[2] as number;
  return lengths.map((count, row) => {
    const vector = new Float32Array(size);
    for (let t = 0; t < count; t++) {
      const offset = (row * length + t) * size;
      for (let d = 0; d < size; d++)
        vector[d] = (vector[d] as number) + (hidden[offset + d] as number);
    }
    let norm = 0;
    for (let d = 0; d < size; d++) {
      vector[d] = (vector[d] as number) / Math.max(1, count);
      norm += (vector[d] as number) ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < size; d++) vector[d] = (vector[d] as number) / norm;
    return vector;
  });
}
