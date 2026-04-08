import type { Augment } from "../types";

export interface MemoryRegistry {
  /** Map of static label → owning augment */
  static: Map<string, Augment>;
  /** Ordered list of (prefix, augment) for namespace providers */
  namespaces: Array<{ prefix: string; augment: Augment }>;
}
