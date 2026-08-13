import { createNameId } from "mnemonic-id";

export const PARENT_LABEL_ENTRY = "pi-herdr-parent-label";

type SessionEntry = { type: string; customType?: string; data?: unknown };

export function findParentLabel(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PARENT_LABEL_ENTRY || !isParentLabel(entry.data)) continue;
    return entry.data.label;
  }
}

export function loadOrCreateParentLabel(
  entries: readonly SessionEntry[],
  persist: (label: string) => void,
  generate = createNameId,
): string {
  const stored = findParentLabel(entries);
  if (stored) return stored;
  const label = generate();
  persist(label);
  return label;
}

function isParentLabel(value: unknown): value is { label: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "label" in value &&
    typeof value.label === "string" &&
    value.label.length > 0
  );
}
