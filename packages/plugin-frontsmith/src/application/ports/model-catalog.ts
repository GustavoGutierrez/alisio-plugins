/** The models the host has connected; used only to validate selectors, never to choose one. */
export interface ModelCatalog {
  /** Canonical `provider/model` references. */
  list(): Promise<string[]>;
  resolve(
    selector: string,
  ): Promise<{ ok: true; reference: string } | { ok: false; message: string }>;
}
