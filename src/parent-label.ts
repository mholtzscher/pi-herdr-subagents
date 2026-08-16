import { createNameId } from "mnemonic-id";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const PARENT_LABEL_ENTRY = "pi-herdr-parent-label";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
const ParentLabelSchema = Type.Object({ label: Type.String({ minLength: 1 }) });

export const findParentLabel = (
  entries: readonly SessionEntry[]
): string | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== PARENT_LABEL_ENTRY ||
      !Check(ParentLabelSchema, entry.data)
    ) {
      continue;
    }
    return entry.data.label;
  }
  return undefined;
};

export const loadOrCreateParentLabel = (
  entries: readonly SessionEntry[],
  persist: (label: string) => void,
  generate = createNameId
): string => {
  const stored = findParentLabel(entries);
  if (stored !== undefined && stored.length > 0) {
    return stored;
  }
  const label = generate();
  persist(label);
  return label;
};
