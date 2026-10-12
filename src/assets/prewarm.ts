import { prop, type PropName } from './kit/props';
import { industry, type IndustryName } from './kit/industry';
import { vehicleAsset } from './vehicles/catalog';
import { wheelGeometry } from './vehicles/wheel';

/**
 * Builds the authored asset caches in small slices while the game idles (title, garage), so the first road
 * segments and the first cars of a run never pay for modelling. Everything is cached on first use anyway:
 * this only moves that cost out of the drive.
 */
const PROPS: PropName[] = [
  'lamp', 'pole', 'poleTx', 'jersey', 'cone', 'container', 'drum', 'xdrum', 'wheelieBin', 'crate', 'block', 'plasticBarrier', 'pillar', 'warnSign',
  'glassRack', 'billboard', 'busStop', 'bin', 'dumpster', 'barrierA', 'generator', 'excavator', 'forklift', 'pallet', 'palletLoad', 'spool',
  'hydrant', 'callbox', 'kiosk', 'pipe', 'cabinet', 'acunit', 'sandbags', 'trafficLight', 'bench', 'waterTank', 'dish', 'tree', 'bollard',
  'boat', 'scaffold', 'rubble', 'heras', 'transformer', 'floodMast', 'mast', 'awning',
];
const INDUSTRY: IndustryName[] = ['pipeRack', 'stack', 'tank', 'silos', 'column', 'towerCrane', 'gantryCrane', 'coolingTower', 'flare', 'hopper', 'pipeBridge', 'tankSmall'];
const TRAFFIC: [string, number][] = [['sedan', 0], ['sedan', 1], ['sedan', 2], ['hatch', 0], ['hatch', 1], ['van', 0], ['van', 1], ['van', 2], ['truck', 0], ['truck', 1], ['truck', 2], ['taxi', 0], ['police', 0]];
const ENEMIES = ['interceptor', 'rammer', 'gunner', 'bomber', 'empvan', 'blocker', 'hunter'];
const HEROES = ['courier', 'ghost', 'player_rammer', 'hauler', 'boss_mule', 'boss_bus', 'boss_taxon', 'boss_apex', 'boss_driver'];

let started = false;
export function prewarmAssets() {
  if (started) return;
  started = true;
  const jobs: (() => void)[] = [];
  for (const p of PROPS) jobs.push(() => prop(p));
  for (const [k, v] of TRAFFIC) jobs.push(() => vehicleAsset(k, v, false, 1), () => vehicleAsset(k, v, false, 2));
  for (const k of ENEMIES) jobs.push(() => vehicleAsset(k, 0, false, 1), () => vehicleAsset(k, 0, false, 2));
  for (const k of HEROES) jobs.push(() => vehicleAsset(k, 0, false, 0));
  for (const i of INDUSTRY) jobs.push(() => industry(i));
  jobs.push(() => {
    for (const d of [0, 1, 2] as const) for (const r of [0.35, 0.36, 0.38, 0.42]) wheelGeometry(r, 0.26, 'spoke5', d);
  });
  const slice = () => {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < 6) jobs.shift()!();
    if (jobs.length) setTimeout(slice, 16);
  };
  setTimeout(slice, 300);
}
