export function addManualTag(currentTags: string[], raw: string): string[] {
  const tag = raw.trim().toLowerCase();
  if (!tag || currentTags.includes(tag)) return currentTags;
  return [...currentTags, tag];
}

export function removeManualTag(currentTags: string[], tag: string): string[] {
  return currentTags.filter(t => t !== tag);
}
