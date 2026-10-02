/*
 * Down-link interference from neighbouring cells. The serving site is placed
 * in the scenario; the neighbours are virtual: two hexagonal tiers (18 sites,
 * 3 sectors each) at the scenario's inter-site distance, with the 3GPP TR
 * 36.777 / 38.901 LOS-probability-weighted path loss. This reproduces the
 * well-known effect that a drone at altitude sees many cells in LOS, so its
 * SINR drops even though the serving signal gets stronger.
 */
import { gpp, gppMeanGain } from './models.js';
import { sectorGain } from './antennas.js';

const SQ3 = Math.sqrt(3);

/** Unit offsets (in ISD) of the 18 tier-1/tier-2 neighbour sites around the serving site. */
export const NEIGHBOURS = (() => {
  const out = [];
  for (let k = 0; k < 6; k++) {
    const a = ((30 + 60 * k) * Math.PI) / 180;
    out.push([Math.cos(a), Math.sin(a)]);
    out.push([2 * Math.cos(a), 2 * Math.sin(a)]);
    const b = (60 * k * Math.PI) / 180;
    out.push([SQ3 * Math.cos(b), SQ3 * Math.sin(b)]);
  }
  return out;
})();

/** Average radiated gain of a beam-steering array towards a random direction = its element pattern. */
const ELEMENT = { kind: 'dir', g: 8, bwAz: 65, bwEl: 65, sla: 30, am: 30, sectors: 3, tilt: 0 };

/**
 * Total interference power (mW) at the drone.
 * @param {object} p
 * @param {number[]} p.site serving site [x, z]
 * @param {number} p.isd inter-site distance (m)
 * @param {string} p.model 3GPP scenario 'UMa' | 'UMi' | 'RMa'
 * @param {number} p.hBS base-station antenna height (m)
 * @param {object} p.ant antenna definition of the sites
 * @param {number} p.txDbm transmit power per sector (dBm)
 * @param {number} p.f carrier (Hz)
 * @param {number} p.load fraction of time/resources the neighbours transmit
 * @param {number[]} p.drone drone position [x, agl, z] (flat-earth approximation)
 * @param {(dir:number[]) => number} p.airGain drone antenna gain towards a world direction
 */
export function neighbourInterference(p) {
  const ant = p.ant.kind === 'steer' ? ELEMENT : p.ant;
  const beamHit = p.ant.narrowBeam ? 0.1 : 1;
  let sum = 0;
  for (const [ux, uz] of NEIGHBOURS) {
    const sx = p.site[0] + ux * p.isd;
    const sz = p.site[1] + uz * p.isd;
    const dx = p.drone[0] - sx;
    const dz = p.drone[2] - sz;
    const d2 = Math.hypot(dx, dz);
    const dy = p.drone[1] - p.hBS;
    const d3 = Math.hypot(d2, dy);
    const dir = [dx / d3, dy / d3, dz / d3];
    const gBs = sectorGain(ant, 30, dir).g;
    const gUe = p.airGain([-dir[0], -dir[1], -dir[2]]);
    const path = gppMeanGain(gpp(p.model, d2, p.hBS, Math.max(p.drone[1], 1.5), p.f));
    sum += p.load * beamHit * Math.pow(10, (p.txDbm + gBs + gUe) / 10) * path;
  }
  return sum;
}
