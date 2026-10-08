import type { ArtifactPublisher, ArtifactRef, UiBlock } from "@alisio/sdk";

/** The context slice the artifact bridge needs; structural so tests can fake it. */
export interface ArtifactContext {
  artifacts?: ArtifactPublisher;
}

export interface PublishRequest {
  sourceFile: string;
  title?: string;
}

/**
 * Plugin-facing limitation shown when the host has no artifact store for external plugins (v1
 * exposes `ToolContext.artifacts` to built-in tools only). The rendered image still travels in
 * the tool result and `card_export` can save it into the workspace.
 */
export const NO_ARTIFACT_BRIDGE_NOTICE =
  "This host cannot publish plugin artifacts yet; the image is shown above and card_export saves it into the workspace.";

/**
 * Publish `sourceFile` through the host artifact store when one is present. Returns `null` when
 * the context has no publisher; the reference always comes from the host, never built here.
 */
export async function publishOrNull(
  context: ArtifactContext,
  request: PublishRequest,
): Promise<ArtifactRef | null> {
  const publisher = context.artifacts;
  if (publisher === undefined) return null;
  return publisher.publish(
    request.title === undefined
      ? { source: request.sourceFile }
      : { source: request.sourceFile, title: request.title },
  );
}

/** Wrap a host-issued artifact reference as the SDK artifact UI block. */
export function artifactBlock(ref: ArtifactRef): UiBlock {
  return { kind: "artifact", artifact: ref };
}
