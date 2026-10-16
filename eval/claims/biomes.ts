/** Sampling regions. Each is a lon/lat box well inside one Hansen tile, chosen for having both
 *  standing forest and recent loss, in different biomes. `season_date` is the claim date
 *  (the start of the "not cleared since" period) in that biome's clearest season. */
export interface Biome {
  id: string
  name: string
  box: [number, number, number, number]
}

export const BIOMES: Biome[] = [
  { id: 'amazon', name: 'Amazon, Para and Mato Grosso (tropical moist forest)', box: [-56.5, -9.0, -52.5, -5.5] },
  { id: 'borneo', name: 'Borneo, Kalimantan (tropical moist forest, perpetually cloudy)', box: [110.5, -3.0, 115.0, -0.5] },
  { id: 'congo', name: 'Congo basin, DRC (tropical moist forest)', box: [21.0, -4.5, 25.0, -1.0] },
  { id: 'pnw', name: 'Pacific Northwest, USA (temperate conifer, managed)', box: [-124.0, 43.5, -121.8, 46.5] },
  { id: 'miombo', name: 'Zambia and Angola, miombo woodland (seasonal dry forest)', box: [24.0, -14.5, 28.0, -11.0] },
]
