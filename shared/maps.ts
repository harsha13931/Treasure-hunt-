// The arenas a match can be played in. The rules are the same in all of them (a ring that closes in over a drop);
// only the setting, the look of the floor and the cage, and the mood change.

export const MAP_IDS = ["frost", "forest", "bridge"] as const;
export type MapId = (typeof MAP_IDS)[number];

export const DEFAULT_MAP: MapId = "frost";

export interface MapInfo {
  id: MapId;
  name: string;
  /** One line shown on the map card. */
  tagline: string;
}

export const MAPS: Record<MapId, MapInfo> = {
  frost: { id: "frost", name: "Frozen Crevasse", tagline: "A ring of ice over a bottomless crack, in a snowstorm." },
  forest: { id: "forest", name: "Emerald Forest", tagline: "An old stone clearing deep in the woods, with fireflies and falling leaves." },
  bridge: { id: "bridge", name: "Canyon Crossing", tagline: "A rope-hung wooden deck high above a canyon at sunset." },
};

export function isMapId(value: unknown): value is MapId {
  return typeof value === "string" && (MAP_IDS as readonly string[]).includes(value);
}

/** A random arena, for public matches where nobody chose. */
export function randomMap(random: () => number = Math.random): MapId {
  return MAP_IDS[Math.floor(random() * MAP_IDS.length)];
}
