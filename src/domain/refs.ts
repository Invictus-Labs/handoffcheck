/**
 * Normalization for operator and builder identity references: Unicode NFKC, trimmed, case-folded. Two references that
 * normalize equal are the same person for the independence rule; a reference that normalizes empty is no reference.
 */
export function normalizeRef(ref: string | undefined | null): string {
  return (ref ?? "").normalize("NFKC").trim().toLowerCase();
}
