/*
 * Radio technologies and bands. Each entry is a link budget plus a PHY
 * abstraction: a mode/MCS table (required SNR for 10 % packet error, data
 * rate), a logistic PER waterfall around each threshold, and the numerology
 * that decides how Doppler and delay spread hurt (subcarrier spacing, cyclic
 * prefix, channel-estimate refresh interval).
 *
 * Tx powers are given per regulatory region; EU follows the ETSI SRD/RLAN
 * limits (EIRP), US the FCC Part 15 practice. Edit freely - they are
 * assumptions, not certifications.
 */
import { besselJ0 } from '../util.js';

const LORA_SF = [
  { name: 'SF7', snr: -6.5, rate: 5470 },
  { name: 'SF8', snr: -9, rate: 3125 },
  { name: 'SF9', snr: -11.5, rate: 1760 },
  { name: 'SF10', snr: -14, rate: 980 },
  { name: 'SF11', snr: -16.5, rate: 440 },
  { name: 'SF12', snr: -19, rate: 250 },
];

/** 802.11n, 20 MHz, 1 spatial stream, 800 ns GI; thresholds for 10 % PER at 1500 B. */
const WIFI_N = [
  { name: 'MCS0 BPSK ½', snr: 2, rate: 6.5e6 },
  { name: 'MCS1 QPSK ½', snr: 5, rate: 13e6 },
  { name: 'MCS2 QPSK ¾', snr: 9, rate: 19.5e6 },
  { name: 'MCS3 16QAM ½', snr: 11, rate: 26e6 },
  { name: 'MCS4 16QAM ¾', snr: 15, rate: 39e6 },
  { name: 'MCS5 64QAM ⅔', snr: 18, rate: 52e6 },
  { name: 'MCS6 64QAM ¾', snr: 20, rate: 58.5e6 },
  { name: 'MCS7 64QAM ⅚', snr: 25, rate: 65e6 },
];

/** LTE CQI table (TS 36.213 Table 7.2.3-1) with typical 10 % BLER SNR thresholds. Efficiency in bit/s/Hz. */
const LTE_CQI = [
  [-6.7, 0.15], [-4.7, 0.23], [-2.3, 0.38], [0.2, 0.6], [2.4, 0.88], [4.3, 1.18], [5.9, 1.48],
  [8.1, 1.91], [10.3, 2.41], [11.7, 2.73], [14.1, 3.32], [16.3, 3.9], [18.7, 4.52], [21, 5.12], [22.7, 5.55],
];
/** NR 256QAM CQI table (TS 38.214 Table 5.2.2.1-3), thresholds extrapolated from the LTE mapping. */
const NR_CQI = [
  [-6.7, 0.15], [-2.3, 0.38], [2.4, 0.88], [5.9, 1.48], [8.1, 1.91], [10.3, 2.41], [11.7, 2.73],
  [14.1, 3.32], [16.3, 3.9], [18.7, 4.52], [21, 5.12], [22.7, 5.55], [24.8, 6.23], [27, 6.91], [29, 7.41],
];
/** Generic OFDM video link (Wi-Fi-like modulation ladder), efficiency in bit/s/Hz. */
const OFDM_GENERIC = [
  [1, 0.5, 'BPSK ½'], [4, 1, 'QPSK ½'], [7, 1.5, 'QPSK ¾'], [10, 2, '16QAM ½'],
  [14, 3, '16QAM ¾'], [18, 4, '64QAM ⅔'], [20, 4.5, '64QAM ¾'], [23, 5, '64QAM ⅚'],
];

function cqiModes(table, bw, overhead, qamNames = true) {
  return table.map(([snr, eff, label], i) => ({
    name: label || (qamNames ? `CQI ${i + 1}` : `MCS ${i}`),
    snr,
    rate: eff * bw * overhead,
    eff,
  }));
}

export const TECHS = [
  {
    id: 'elrs24', name: 'ELRS 2.4 GHz', group: 'Control', node: 'pilot', kind: 'lora',
    f: { eu: 2.44e9, us: 2.44e9 }, bw: 812.5e3, tx: { eu: 20, us: 24 }, nf: 6, rx: 'air', ism: '24',
    modes: [{ name: 'LoRa SF6 · 250 Hz', snr: -3, rate: 16e3 }], slope: 1.2, pkt: 8, need: 0,
    gsAnt: 'dipole', airAnt: 'dual_vh', note: 'RC uplink, fixed packet rate',
  },
  {
    id: 'elrs900', name: 'ELRS / Crossfire 868·915', group: 'Control', node: 'pilot', kind: 'lora',
    f: { eu: 868e6, us: 915e6 }, bw: 500e3, tx: { eu: 14, us: 27 }, nf: 6, rx: 'air', ism: 'sub',
    modes: [{ name: 'LoRa SF7 · 100 Hz', snr: -5.5, rate: 6.4e3 }], slope: 1.2, pkt: 8, need: 0,
    gsAnt: 'dipole', airAnt: 'dipole_v', note: 'RC uplink, long-range mode',
  },
  {
    id: 'sik', name: 'SiK telemetry 433·915', group: 'Telemetry', node: 'pilot', kind: 'fsk',
    f: { eu: 433.5e6, us: 915e6 }, bw: 150e3, tx: { eu: 10, us: 20 }, nf: 7, rx: 'ground', ism: 'sub',
    modes: [{ name: 'GFSK 64 kbit/s', snr: 10, rate: 64e3 }], slope: 1.5, pkt: 64, symT: 15.6e-6, need: 20e3,
    gsAnt: 'dipole', airAnt: 'dipole_v', note: 'MAVLink telemetry downlink',
  },
  {
    id: 'lora', name: 'LoRa 868·915 (ADR)', group: 'Telemetry', node: 'pilot', kind: 'lora',
    f: { eu: 868.1e6, us: 915e6 }, bw: 125e3, tx: { eu: 14, us: 20 }, nf: 6, rx: 'ground', ism: 'sub',
    modes: LORA_SF.slice().reverse(), adaptive: true, laMargin: 5, slope: 1.0, pkt: 24, need: 0,
    gsAnt: 'collinear', airAnt: 'dipole_v', note: 'Remote-ID / IoT telemetry, adaptive spreading factor',
  },
  {
    id: 'wifi24', name: 'Wi-Fi 2.4 GHz (11n)', group: 'Video & data', node: 'pilot', kind: 'ofdm',
    f: { eu: 2.437e9, us: 2.437e9 }, bw: 20e6, tx: { eu: 20, us: 27 }, nf: 7, rx: 'ground', ism: '24',
    modes: WIFI_N, adaptive: true, laMargin: 2, slope: 1.5, pkt: 1500, mac: 0.65,
    scs: 312.5e3, cp: 0.8e-6, tEst: 'packet', need: 4e6,
    gsAnt: 'patch', airAnt: 'dual_space', note: 'Preamble-only channel estimate: long packets age at speed',
  },
  {
    id: 'video58', name: 'Digital video 5.8 GHz', group: 'Video & data', node: 'pilot', kind: 'ofdm',
    f: { eu: 5.8e9, us: 5.8e9 }, bw: 20e6, tx: { eu: 14, us: 28 }, nf: 6, rx: 'ground', ism: '58',
    modes: cqiModes(OFDM_GENERIC, 20e6, 0.75), adaptive: true, laMargin: 1.5, slope: 1.6, pkt: 1200,
    scs: 15e3, cp: 4.7e-6, tEst: 0.25e-3, need: 10e6,
    gsAnt: 'patch', airAnt: 'dual_space', note: 'OcuSync-style OFDM with pilots (numerology assumed)',
  },
  {
    id: 'analog58', name: 'Analog FPV 5.8 GHz', group: 'Video & data', node: 'pilot', kind: 'analog',
    f: { eu: 5.8e9, us: 5.8e9 }, bw: 18e6, tx: { eu: 14, us: 23 }, nf: 8, rx: 'ground', ism: '58',
    modes: [{ name: 'FM video', snr: 10, rate: 0 }], slope: 0.9, need: 0,
    gsAnt: 'helix', airAnt: 'cp_omni', note: 'Graceful degradation; "PER" = time below the FM threshold',
  },
  {
    id: 'lte800', name: 'LTE 800 (B20)', group: 'Cellular', node: 'cell', kind: 'ofdm',
    f: { eu: 806e6, us: 751e6 }, bw: 10e6, tx: { eu: 46, us: 46 }, nf: 7, rx: 'air', ism: null,
    modes: cqiModes(LTE_CQI, 10e6, 0.72), adaptive: true, laMargin: 1, slope: 2, pkt: 1000,
    scs: 15e3, cp: 4.7e-6, tEst: 0.25e-3, need: 0.3e6,
    ul: { tx: 23, bw: 4.5e6, nf: 3, iot: 3, overhead: 0.8, need: 3e6 },
    gsAnt: 'sector', airAnt: 'dipole_v', note: 'C2 downlink; video uplink derived from the same channel',
  },
  {
    id: 'nr35', name: '5G NR 3.5 GHz (n78)', group: 'Cellular', node: 'cell', kind: 'ofdm',
    f: { eu: 3.6e9, us: 3.7e9 }, bw: 40e6, tx: { eu: 46, us: 46 }, nf: 9, rx: 'air', ism: null,
    modes: cqiModes(NR_CQI, 40e6, 0.62), adaptive: true, laMargin: 1, slope: 2, pkt: 1000,
    scs: 30e3, cp: 2.34e-6, tEst: 0.25e-3, need: 1e6,
    ul: { tx: 26, bw: 20e6, nf: 5, iot: 3, overhead: 0.2, need: 8e6 },
    gsAnt: 'mmimo', airAnt: 'dipole_v', note: 'TDD; beams scan only a limited vertical range',
  },
  {
    id: 'nr26', name: '5G NR 26 GHz (n258)', group: 'Cellular', node: 'cell', kind: 'ofdm',
    f: { eu: 26e9, us: 27.5e9 }, bw: 200e6, tx: { eu: 33, us: 33 }, nf: 10, rx: 'air', ism: null,
    modes: cqiModes(NR_CQI, 200e6, 0.6), adaptive: true, laMargin: 1, slope: 2, pkt: 1000,
    scs: 120e3, cp: 0.57e-6, tEst: 0.125e-3, need: 5e6,
    ul: { tx: 23, bw: 100e6, nf: 7, iot: 2, overhead: 0.2, need: 20e6 },
    gsAnt: 'mmarray', airAnt: 'ue_array', note: 'Needs clear LOS; foliage is fatal',
  },
];

export const TECH_BY_ID = Object.fromEntries(TECHS.map((t) => [t.id, t]));

/** Packet error rate on a logistic waterfall: PER(threshold) = 10 %. */
export function perAt(snrDb, thresholdDb, slope) {
  return 1 / (1 + 9 * Math.exp(slope * (snrDb - thresholdDb)));
}

/** Highest mode whose threshold is met by snrDb − margin (index 0 if none). */
export function pickMode(tech, snrDb) {
  if (!tech.adaptive) return 0;
  const target = snrDb - (tech.laMargin || 0);
  let best = 0;
  for (let i = 0; i < tech.modes.length; i++) if (tech.modes[i].snr <= target) best = i;
  return best;
}

/** Effective throughput of a mode (bit/s) including MAC efficiency where defined. */
export function modeRate(tech, mode) {
  return mode.rate * (tech.mac || 1);
}

/**
 * Self-interference terms from mobility and multipath, as noise power relative
 * to the signal (linear). They only act on the diffuse share 1/(K+1):
 *  - ICI: Doppler spread vs subcarrier spacing, (π²/3)(fd/Δf)² (Russell & Stüber)
 *  - aging: channel estimate outdated by T, 2(1 − J0(π·fd·T)) (Jakes correlation)
 *  - ISI: multipath energy beyond the cyclic prefix, exp(−CP/στ) for an exponential PDP
 */
export function impairments(tech, mode, fdMax, kLin, ds) {
  const diffuse = 1 / (kLin + 1);
  let ici = 0;
  let aging = 0;
  let isi = 0;
  if (tech.kind === 'ofdm') {
    const r = fdMax / tech.scs;
    ici = diffuse * (Math.PI ** 2 / 3) * r * r;
    const tEst = tech.tEst === 'packet' ? 20e-6 + (8 * tech.pkt) / Math.max(mode.rate, 1e5) : tech.tEst;
    aging = diffuse * 2 * (1 - besselJ0(Math.PI * fdMax * tEst));
    isi = diffuse * Math.exp(-tech.cp / Math.max(ds, 1e-10));
  } else if (tech.kind === 'fsk') {
    isi = diffuse * Math.min(1, (ds / (0.3 * tech.symT)) ** 2);
  }
  const total = ici + aging + isi;
  let name = 'Doppler ICI';
  if (aging >= ici && aging >= isi) name = 'channel aging';
  else if (isi >= ici) name = 'delay spread vs CP';
  return { ici, aging, isi, total, name, ceilingDb: total > 0 ? -10 * Math.log10(total) : Infinity };
}

/** Noise floor in dBm for a bandwidth and noise figure. */
export function noiseFloor(bw, nf) {
  return -174 + 10 * Math.log10(bw) + nf;
}

export const VERDICTS = [
  { level: 0, label: 'No link', icon: '✕', status: 'critical' },
  { level: 1, label: 'Poor', icon: '✕', status: 'critical' },
  { level: 2, label: 'Marginal', icon: '!', status: 'serious' },
  { level: 3, label: 'Good', icon: '✓', status: 'good' },
  { level: 4, label: 'Excellent', icon: '✓', status: 'good' },
];

/**
 * Judges a technology from its 5 s statistics.
 * s: { snrMean, snr10, per, outage, thr, thrUl, sirDb, riseDb, imp: {name, ceilingDb}, impDb, effFade, pathLoss, losses }
 */
export function judge(tech, s) {
  const minSnr = Math.min(...tech.modes.map((m) => m.snr));
  const maxSnr = Math.max(...tech.modes.map((m) => m.snr));
  const reasons = [];
  const margin10 = s.snr10 - minSnr;
  let level;
  if (!Number.isFinite(s.snrMean) || s.per > 0.9 || s.snrMean < minSnr - 3) level = 0;
  else if (s.per > 0.2 || margin10 < -3) level = 1;
  else if (s.per > 0.05 || margin10 < 3) level = 2;
  else if (s.per > 0.01 || margin10 < 10) level = 3;
  else level = 4;

  if (tech.need && s.thr < tech.need) {
    level = Math.min(level, s.thr < tech.need / 2 ? 1 : 2);
    reasons.push(`${fmtMbps(s.thr)} of ${fmtMbps(tech.need)} needed`);
  }
  if (tech.ul && s.thrUl !== undefined && s.thrUl < tech.ul.need) {
    level = Math.min(level, s.thrUl < tech.ul.need / 2 ? 1 : 2);
    reasons.push(`uplink ${fmtMbps(s.thrUl)} of ${fmtMbps(tech.ul.need)}`);
  }
  for (const l of [...(s.losses || [])].sort((a, b) => b.value - a.value)) {
    if (l.value >= 6) reasons.push(`${l.label} −${l.value.toFixed(0)} dB`);
  }
  if (Number.isFinite(s.sirDb) && s.sirDb < 15 && s.interfDb > 6) reasons.push(`neighbour cells: SIR ${s.sirDb.toFixed(0)} dB`);
  if (s.riseDb >= 3) reasons.push(`band noise +${s.riseDb.toFixed(0)} dB`);
  if (s.imp && s.impDb >= 1 && s.imp.ceilingDb < maxSnr + 3) reasons.push(`${s.imp.name} caps SINR at ${s.imp.ceilingDb.toFixed(0)} dB`);
  if (s.outage > 0.01 && s.snrMean > minSnr + 3) reasons.push(`fading outage ${(s.outage * 100).toFixed(0)} %`);
  const marginText = margin10 < 0 ? `${(-margin10).toFixed(0)} dB short at the 10 % point` : `${margin10.toFixed(0)} dB margin at the 10 % point`;
  if (level >= 3) reasons.unshift(marginText);
  else if (!reasons.length) {
    reasons.push(marginText);
    if (Number.isFinite(s.pathLoss)) reasons.push(`path loss ${s.pathLoss.toFixed(0)} dB`);
  }
  return { ...VERDICTS[level], reasons, margin10 };
}

function fmtMbps(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbit/s`;
  return `${(bps / 1e3).toFixed(0)} kbit/s`;
}
