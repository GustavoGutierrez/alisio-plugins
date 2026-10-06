import type { WorkspaceWriter } from "../../application/ports/workspace-writer.js";
import { atomicWrite, resolveContained } from "./storage.js";

export class FsWorkspaceWriter implements WorkspaceWriter {
  async write(root: string, relative: string, content: string): Promise<void> {
    await atomicWrite(await resolveContained(root, relative), content);
  }
}
