/**
 * RF spectrum analysis helpers for the 2.4 GHz band.
 */

// Non-overlapping 2.4GHz channels in most regions
const NON_OVERLAPPING = [1, 6, 11];

/**
 * Compute an interference score per channel taking adjacent-channel
 * overlap into account (channels within 4 of each other overlap in 2.4GHz).
 * Returns { scores: {ch: score}, best, worst, recommended }.
 */
function analyzeChannels(wifiHeatmap) {
  const scores = {};
  for (let ch = 1; ch <= 13; ch++) {
    let score = 0;
    for (let other = 1; other <= 13; other++) {
      const data = wifiHeatmap[other];
      if (!data || !data.count) continue;
      const dist = Math.abs(ch - other);
      if (dist > 4) continue; // no significant overlap beyond 4 channels apart
      // weight: same channel = 1, decays with distance
      const overlapWeight = 1 - dist / 5;
      // include signal strength: stronger APs interfere more
      const rssiWeight = Math.max(0.2, Math.min(1, (data.maxRssi + 95) / 55));
      score += data.count * overlapWeight * rssiWeight;
    }
    scores[ch] = Math.round(score * 10) / 10;
  }

  // Best/worst across all channels
  let best = 1, worst = 1, minScore = Infinity, maxScore = -Infinity;
  for (let ch = 1; ch <= 13; ch++) {
    if (scores[ch] < minScore) { minScore = scores[ch]; best = ch; }
    if (scores[ch] > maxScore) { maxScore = scores[ch]; worst = ch; }
  }

  // Recommended: cleanest among the non-overlapping 1/6/11 set (standard advice)
  let recommended = NON_OVERLAPPING[0];
  let recMin = Infinity;
  NON_OVERLAPPING.forEach(ch => {
    if (scores[ch] < recMin) { recMin = scores[ch]; recommended = ch; }
  });

  return { scores, bestChannel: best, worstChannel: worst, recommendedChannel: recommended };
}

/**
 * Detect potential "evil twin" APs: the same SSID advertised by more
 * than one distinct BSSID. Returns a Set of flagged MAC/BSSIDs.
 */
function detectEvilTwins(devices) {
  const bySsid = new Map();
  devices.forEach(d => {
    if (d.type !== 'wifi') return;
    const ssid = (d.ssid || '').trim();
    if (!ssid || ssid === 'Oculto' || ssid === 'Hidden') return;
    if (!bySsid.has(ssid)) bySsid.set(ssid, new Set());
    bySsid.get(ssid).add((d.mac || '').toLowerCase());
  });

  const flagged = new Set();
  bySsid.forEach((macs, ssid) => {
    if (macs.size > 1) {
      macs.forEach(m => flagged.add(m));
    }
  });
  return flagged;
}

module.exports = { analyzeChannels, detectEvilTwins, NON_OVERLAPPING };
