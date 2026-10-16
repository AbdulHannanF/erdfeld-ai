/** Higher-level products built from the measured layers. */

import { z } from 'zod'

import { classifyLandCover, detectChange, detectDeforestation } from '../../tools/derived'
import { classifyVegetation } from '../../tools/inference'
import { DAY, HOUR, defineOperation, type AnyOperation } from '../operation'

export const derivedOps: AnyOperation[] = [
  defineOperation({
    name: 'classify_land_cover',
    label: 'Classifying Land Cover...',
    version: '2.0.0',
    description: 'Land cover of the AOI from ESA WorldCover 2021 (10 m, 11 official classes): the share of each class among the classified pixels inside the drawn polygon, and a categorical map layer in the official WorldCover colours with a legend. Use when the user asks about "land cover", "land use", "what is this area", or "what type of land". It is a 2021 product: use detect_change for what changed since. Fails (never guesses) when WorldCover cannot be read.',
    params: z.object({}),
    output: 'raster',
    sensors: ['esa-worldcover'],
    resolution_m: 10,
    cost: { typicalSeconds: 15 },
    cacheTtl: { liveMs: 30 * DAY },
    limitations: [
      'ESA WorldCover 2021: a fixed 2021 classification, not current land cover; land changed since then is not reflected.',
      'Shares are of classified pixels inside the polygon, counted on a grid capped at 1000 px (about 10 m for AOIs under 10 km across, coarser for larger ones; the result states it).',
      'ESA reports about 75% overall global accuracy; small or mixed patches are often assigned to a neighbouring class.',
      'Eleven fixed classes: it cannot separate crop types or tree species.',
    ],
    confidence: 'high: the polygon is at least 95% covered by WorldCover classes (the layer reproduces the product, whose own accuracy is about 75% globally); medium when part of the polygon is unclassified.',
    run: (ctx) => classifyLandCover(ctx),
  }),
  defineOperation({
    name: 'detect_change',
    label: 'Detecting Change...',
    version: '1.1.0',
    description: 'Detect land-cover change between two Sentinel-2 scenes. By default the latest scene against one 6-12 months earlier; with `before` / `after` dates, any two dates (use them whenever the question states a period). Returns NDVI delta, change direction (increase/decrease/stable), and magnitude. Use when the user asks about "change", "change detection", "before and after", "what changed", or "compare seasons".',
    params: z.object({
      before: z.string().optional().describe('YYYY-MM-DD of the earlier (baseline) state; scenes within ~30 days of it are used. For a question about a stated period, give a date at the START of that period. Omit for the default baseline.'),
      after: z.string().optional().describe('YYYY-MM-DD of the later state; scenes within ~30 days of it are used. For a question about a stated period, give a date at the END of that period, in the same season as `before`. Omit for the latest imagery.'),
    }),
    limits: { earliest: '2015-06-23', needsDates: true },
    output: 'mixed',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    cost: { typicalSeconds: 20 },
    cacheTtl: { liveMs: 6 * HOUR },
    limitations: [
      'Compares two single Sentinel-2 scenes (by default the latest vs one 6-12 months earlier, or the dates given): seasonal change (crop cycle, leaf-off) is indistinguishable from permanent change.',
      'NDVI delta only: it shows vegetation change, not what caused it.',
    ],
    confidence: 'medium: two clear scenes give a real delta; with fewer clear pixels the delta is weaker.',
    run: (ctx, args) => detectChange(ctx, args),
  }),
  defineOperation({
    name: 'detect_deforestation',
    label: 'Detecting Deforestation...',
    version: '1.1.0',
    description: 'Detect deforestation by comparing a forested baseline against a later Sentinel-2 NDVI. By default 1-2 years ago against the latest imagery; with `before` / `after` dates, any two dates (use them whenever the question states a period, e.g. a claim about 2020 to 2023). Returns deforestation flag, alert level (none/low/medium/high), and forest cover change percentage. Use when the user asks about "deforestation", "forest loss", "tree cover", or "logging".',
    params: z.object({
      before: z.string().optional().describe('YYYY-MM-DD of the earlier (baseline) state; scenes within ~45 days of it are used. For a question about a stated period, give a date at the START of that period. Omit for the default baseline.'),
      after: z.string().optional().describe('YYYY-MM-DD of the later state; scenes within ~45 days of it are used. For a question about a stated period, give a date at the END of that period, in the same season as `before`. Omit for the latest imagery.'),
    }),
    limits: { earliest: '2015-06-23', needsDates: true },
    output: 'mixed',
    sensors: ['sentinel-2-l2a'],
    resolution_m: 10,
    cost: { typicalSeconds: 25 },
    cacheTtl: { liveMs: 6 * HOUR },
    limitations: [
      'Compares a baseline (by default 1-2 years ago, or the date given) with a later Sentinel-2 NDVI (by default the latest, or the date given); it cannot tell logging from a drought, fire or harvest.',
      'The alert level is a threshold on NDVI loss, a screening signal and not a forest-cover survey.',
    ],
    confidence: 'medium: real two-epoch NDVI comparison; the alert level is heuristic.',
    run: (ctx, args) => detectDeforestation(ctx, args),
  }),
  defineOperation({
    name: 'classify_vegetation',
    label: 'Classifying vegetation type (WorldCover + NDVI)...',
    version: '1.1.0',
    description: 'Classify the functional vegetation type for the AOI — the honest answer to "what kind of trees/vegetation is this?" Combines ESA WorldCover 2021 land cover + NDVI (from GEE when configured, else WorldCover) + optional Prithvi-EO-2.0 foundation model classification (when INFERENCE_PROVIDER is set). Always honest about resolution: at 10 m Sentinel-2, returns functional type (broadleaf/needleleaf, canopy density, NDVI) — NEVER species. Species ID requires sub-meter or hyperspectral imagery. Use when asked: "what kind of trees", "what vegetation is this", "forest type", "what crops are growing", "vegetation analysis", "land cover type".',
    params: z.object({}),
    output: 'table',
    sensors: ['sentinel-2-l2a', 'esa-worldcover-2021'],
    resolution_m: 10,
    cost: { typicalSeconds: 10 },
    cacheTtl: { liveMs: 6 * HOUR },
    limitations: [
      'At 10 m the honest answer is functional type (broadleaf / needleleaf, canopy density, NDVI), never species; species needs sub-metre or hyperspectral imagery.',
      'ESA WorldCover is a single year (2021).',
    ],
    confidence: 'medium: WorldCover class plus measured NDVI; resolution-limited by design.',
    target: () => 'functional_type',
    run: (ctx, args) => classifyVegetation(ctx, args),
  }),
]
