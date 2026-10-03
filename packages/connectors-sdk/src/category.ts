/**
 * Maps a marketplace's own category label ("Monitors", "Cell Phones &
 * Accessories", "Electric Guitars / Solid Body") onto this system's canonical
 * V1 categories — the vocabulary the risk category gate (`risk`
 * CATEGORY_POLICY) and the matcher (exact demand/supply category equality)
 * both use. Without it every real listing reads as an unknown category and the
 * gate drops it as review-required.
 *
 * Unmapped labels are returned unchanged, so the gate still drops them —
 * failing closed rather than guessing a category.
 */
const KEYWORDS: [RegExp, string][] = [
  [/guitar|bass|amplifier|\bamps?\b|drum|piano|synth|ukulele|violin|cello|banjo|mandolin|musical instrument|effects pedal|\bpedals?\b/, "musical_instruments"],
  [/monitor|computer|laptop|notebook|tablet|phone|camera|\btvs?\b|television|headphone|earbud|audio|video|electronic|cable|console|gaming|printer|router|speaker/, "electronics"],
  [/chair|desk|table|sofa|couch|furniture|shel(f|ves)|cabinet|bed frame|dresser/, "furniture"],
  [/cloth|apparel|shirt|jacket|coat|dress|shoe|sneaker|boot|jeans|pants/, "apparel"],
  [/office|stationery|paper|pens?\b/, "office_supplies"],
  [/\btools?\b|drill|saw\b|wrench|power tool|hand tool/, "tools"],
  [/kitchen|home|garden|decor|bedding|bath|appliance|lighting/, "home_goods"],
];

export function canonicalCategory(sourceCategory: string | null | undefined): string | null {
  if (!sourceCategory) return null;
  const label = sourceCategory.toLowerCase();
  for (const [pattern, category] of KEYWORDS) {
    if (pattern.test(label)) return category;
  }
  return sourceCategory;
}
