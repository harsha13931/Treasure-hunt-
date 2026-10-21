import type { MapId } from "../../../shared/maps.js";
import { buildBridge } from "./bridge.js";
import type { MapContext, MapScene } from "./common.js";
import { buildForest } from "./forest.js";
import { buildFrost } from "./frost.js";

export type { MapContext, MapScene } from "./common.js";

const BUILDERS: Record<MapId, (context: MapContext) => MapScene> = {
  frost: buildFrost,
  forest: buildForest,
  bridge: buildBridge,
};

export function buildMap(id: MapId, context: MapContext): MapScene {
  return BUILDERS[id](context);
}
