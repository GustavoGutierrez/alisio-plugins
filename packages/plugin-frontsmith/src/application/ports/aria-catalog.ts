export interface AriaCatalog {
  schemaVersion: 1;
  catalog: string;
  attributes: string[];
  roles: string[];
  /** Attributes a role must carry unless a native element supplies the semantics. */
  requiredAttributes: Record<string, string[]>;
  /** Role -> native selectors (`h1`, `input:checkbox`) that already provide its required state. */
  nativeSemantics: Record<string, string[]>;
}
