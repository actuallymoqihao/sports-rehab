/**
 * sports-rehab 视频分析核心（纯 JS，浏览器与 Node 通用）
 *
 * 这是 assets/jump_from_video.py 的 JS 移植版：同样的 HSV 阈值、同样的质心提取、
 * 同样的事件识别规则。移植的目的是让手机上也能算，而不是维护两套逻辑。
 *
 * 输入是 RGBA 像素帧（<canvas> getImageData 和 ffmpeg rawvideo 都是这个格式）。
 */

// HSV 预设，与 Python 版逐字对齐（OpenCV 约定：H 0-179, S/V 0-255）
export const COLOR_PRESETS = {
  cyan:    { h: [85, 95],   s: [120, 255], v: [120, 255] },
  magenta: { h: [140, 170], s: [110, 255], v: [110, 255] },
  yellow:  { h: [20, 35],   s: [120, 255], v: [120, 255] },
  green:   { h: [45, 80],   s: [110, 255], v: [90, 255] },
  red:     { h: [0, 8],     s: [120, 255], v: [110, 255] },
  blue:    { h: [100, 125], s: [120, 255], v: [110, 255] },
  orange:  { h: [9, 19],    s: [130, 255], v: [140, 255] },
};

export const REBOUND_MAX_CONTACT_MS = 400;
const G = 9.80665;

/** 单遍扫描 RGB→HSV，同时产出所有目标颜色的掩膜（比逐色重建快数倍） */
function buildMasks(data, colorNames) {
  const n = (data.length / 4) | 0;
  const masks = {};
  const specs = [];
  for (const c of colorNames) {
    masks[c] = new Uint8Array(n);
    const p = COLOR_PRESETS[c];
    specs.push([masks[c], p.h[0], p.h[1], p.s[0], p.s[1], p.v[0], p.v[1]]);
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const delta = max - min;
    const v = max;
    const s = max === 0 ? 0 : Math.round((delta * 255) / max);
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = 30 * (((g - b) / delta) % 6);
      else if (max === g) h = 30 * ((b - r) / delta + 2);
      else h = 30 * ((r - g) / delta + 4);
      if (h < 0) h += 180;
      if (h > 180.0001) h -= 180;
    }
    for (let k = 0; k < specs.length; k++) {
      const sp = specs[k];
      if (v >= sp[5] && v <= sp[6] && s >= sp[3] && s <= sp[4] && h >= sp[1] && h <= sp[2]) sp[0][i] = 1;
    }
  }
  return masks;
}

/** 开运算（腐蚀+膨胀），去掉孤立噪点。morphology:'none' 时跳过以提速 */
function morph(mask, w, h) {
  const eroded = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) eroded[i] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      if (eroded[i] || eroded[i - 1] || eroded[i + 1] || eroded[i - w] || eroded[i + w]) out[i] = 1;
    }
  }
  return out;
}

/** 连通域找色块，返回按 y 升序的前 topN 个（面积降序取前 topN 再按 y 排） */
function findBlobs(mask, w, h, minArea, topN) {
  const seen = new Uint8Array(mask.length);
  const blobs = [];
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0, sx = 0, sy = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++; sx += x; sy += y;
      const nb = [i - 1, i + 1, i - w, i + w];
      for (let k = 0; k < 4; k++) {
        const j = nb[k];
        if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue;
        // 防止跨行串连
        if (k === 0 && x === 0) continue;
        if (k === 1 && x === w - 1) continue;
        seen[j] = 1;
        stack[sp++] = j;
      }
    }
    if (area >= minArea) blobs.push({ x: sx / area, y: sy / area, area });
  }
  blobs.sort((a, b) => b.area - a.area);
  const top = blobs.slice(0, topN);
  top.sort((a, b) => a.y - b.y);
  return top;
}

/**
 * 逐帧追踪。
 * frames: 可迭代对象或**异步**迭代器，每次产出
 *         { data: Uint8ClampedArray|Uint8Array(RGBA), width, height }
 *         异步迭代是为了流式处理——960 帧 × 1080p 全读进内存要 2 GB，手机必崩。
 * specs:  { colorName: topN }
 * 返回   { colorName: { y: number[][], x: number[][], n: number[] } }
 */
export async function trackFrames(frames, specs, opts = {}) {
  const useMorph = (opts.morphology || 'open') !== 'none';
  const names = Object.keys(specs);
  const tracks = {};
  for (const c of names) tracks[c] = { y: [], x: [], n: [] };
  let idx = 0;
  for await (const frame of frames) {
    const { data, width: w, height: h } = frame;
    const minArea = Math.max(4, 2e-5 * w * h);
    const masks = buildMasks(data, names);
    for (const c of names) {
      const mask = useMorph ? morph(masks[c], w, h) : masks[c];
      const blobs = findBlobs(mask, w, h, minArea, specs[c]);
      tracks[c].y.push(blobs.map(b => b.y));
      tracks[c].x.push(blobs.map(b => b.x));
      tracks[c].n.push(blobs.length);
    }
    idx++;
    if (opts.onProgress) opts.onProgress(idx);
  }
  return { tracks, frames: idx };
}

// ---------------- 序列工具 ----------------

export function blobSeries(tracks, color, k) {
  return tracks[color].y.map(b => (b.length > k ? b[k] : NaN));
}
export function blobSeriesX(tracks, color, k) {
  return tracks[color].x.map(b => (b.length > k ? b[k] : NaN));
}
export function interpNaN(a) {
  const out = Float64Array.from(a, v => (Number.isFinite(v) ? v : NaN));
  const good = [];
  for (let i = 0; i < out.length; i++) if (Number.isFinite(out[i])) good.push(i);
  if (good.length === 0) return { arr: out, conf: 0 };
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    let lo = -1, hi = -1;
    for (const g of good) { if (g < i) lo = g; else { hi = g; break; } }
    if (lo < 0) out[i] = out[hi];
    else if (hi < 0) out[i] = out[lo];
    else out[i] = out[lo] + (out[hi] - out[lo]) * ((i - lo) / (hi - lo));
  }
  return { arr: out, conf: good.length / out.length };
}
export function smooth(a, win) {
  win = Math.floor(win);
  if (win <= 2 || a.length < 3) return Float64Array.from(a);
  if (win % 2 === 0) win -= 1;
  if (win < 3) return Float64Array.from(a);
  const pad = (win - 1) / 2;
  const out = new Float64Array(a.length);
  const half = Math.floor(win / 2);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = Math.min(a.length - 1, Math.max(0, i + k)); // edge padding
      s += a[j];
    }
    out[i] = s / win;
  }
  return out;
}
export function median(a) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(a, p) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
export function argMin(a) {
  let bi = 0, bv = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] < bv) { bv = a[i]; bi = i; }
  return bi;
}

export function contactIntervals(shoeY, groundY, tolPx, minFrames) {
  const out = [];
  let start = null;
  for (let i = 0; i < shoeY.length; i++) {
    const near = Math.abs(shoeY[i] - groundY) <= tolPx;
    if (near && start === null) start = i;
    else if (!near && start !== null) {
      if (i - start >= minFrames) out.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null && shoeY.length - start >= minFrames) out.push([start, shoeY.length - 1]);
  return out;
}

export function estimateScale(p1, p2, refCm) {
  const dx = p1[0] - p2[0], dy = p1[1] - p2[1];
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < 10) {
    throw new Error(`标定失败：两个标定标记像素间距只有 ${dist.toFixed(1)}，无法换算比例尺。`);
  }
  if (!(refCm > 0)) throw new Error('标定间距必须是正数。');
  return { pxPerCm: dist / refCm, pxPerCmV: Math.abs(dy) / refCm, dist };
}

/**
 * 主分析：与 Python 版同规则。
 * cfg = { fps, calibColor 或 calibColors:[a,b], hipColor, shoeColor|null, mode, refCm, quietS }
 */
export function analyzeTracks(tracks, cfg) {
  const { fps, hipColor, shoeColor, mode, refCm } = cfg;
  const warnings = [], notes = [];
  const r = { fps, mode, warnings, notes };

  // ---- 标定 ----
  const calibColors = cfg.calibColors || [cfg.calibColor];
  let p1, p2, conf;
  if (calibColors.length === 1) {
    const c = calibColors[0];
    const a = interpNaN(blobSeries(tracks, c, 0));
    const b = interpNaN(blobSeries(tracks, c, 1));
    const ax = interpNaN(blobSeriesX(tracks, c, 0));
    const bx = interpNaN(blobSeriesX(tracks, c, 1));
    if (a.conf < 0.3 || b.conf < 0.3) {
      throw new Error(`视频里几乎找不到第二个标定标记（颜色 ${c}）——两个同色标定标记都必须全程可见。`);
    }
    p1 = [median(ax.arr), median(a.arr)];
    p2 = [median(bx.arr), median(b.arr)];
    conf = Math.min(a.conf, b.conf);
  } else {
    const [ca, cb] = calibColors;
    const a = interpNaN(blobSeries(tracks, ca, 0));
    const b = interpNaN(blobSeries(tracks, cb, 0));
    const ax = interpNaN(blobSeriesX(tracks, ca, 0));
    const bx = interpNaN(blobSeriesX(tracks, cb, 0));
    if (a.conf < 0.3 || b.conf < 0.3) throw new Error('标定标记识别率过低，请重拍。');
    p1 = [median(ax.arr), median(a.arr)];
    p2 = [median(bx.arr), median(b.arr)];
    conf = Math.min(a.conf, b.conf);
  }
  const sc = estimateScale(p1, p2, refCm);
  r.pxPerCm = sc.pxPerCm;
  r.pxPerCmV = sc.pxPerCmV;
  r.calibFoundPct = conf * 100;
  r.spaceResolutionCm = sc.pxPerCmV > 0 ? 1 / sc.pxPerCmV : null;
  if (sc.pxPerCmV < sc.pxPerCm * 0.5) {
    warnings.push('标定标记接近水平摆放：跳跃是竖直测量，请把两个标定标记改成竖直摆放。');
  }

  // ---- 髋部 ----
  const hip = interpNaN(blobSeries(tracks, hipColor, 0));
  r.hipFoundPct = hip.conf * 100;
  if (hip.conf < 0.5) warnings.push(`髋部标记只识别到 ${(hip.conf * 100).toFixed(0)}% 的帧，结果不可靠。`);
  const hipY = smooth(hip.arr, Math.max(3, Math.round(fps / 40)));

  // ---- 鞋部 ----
  let intervals = [];
  if (shoeColor) {
    const shoe = interpNaN(blobSeries(tracks, shoeColor, 0));
    r.shoeFoundPct = shoe.conf * 100;
    if (shoe.conf >= 0.5) {
      const shoeY = smooth(shoe.arr, Math.max(3, Math.round(fps / 60)));
      const groundY = percentile(shoeY, 97);
      const tol = Math.max(2, 0.8 * sc.pxPerCmV);
      intervals = contactIntervals(shoeY, groundY, tol, Math.max(2, Math.round(0.03 * fps)));
      r.contactIntervalsS = intervals.map(([a, b]) => ({
        startS: +(a / fps).toFixed(4), endS: +(b / fps).toFixed(4),
        durationMs: +(((b - a + 1) / fps) * 1000).toFixed(1),
      }));
    } else {
      warnings.push(`鞋部标记只识别到 ${(shoe.conf * 100).toFixed(0)}% 的帧，无法算触地时间。`);
    }
  }

  // ---- 事件识别（优先反弹式短触地）----
  let takeoffI = null, apexI = null, ctMs = null, source = null;
  let best = null;
  for (const [a, b] of intervals) {
    const durMs = ((b - a + 1) / fps) * 1000;
    if (durMs > REBOUND_MAX_CONTACT_MS) continue;
    const seg = hipY.slice(b + 1);
    if (seg.length < 3) continue;
    const ai = b + 1 + argMin(seg);
    const rise = hipY[b] - hipY[ai];
    if (!best || rise > best.rise) best = { rise, b, ai, durMs };
  }
  if (best && best.rise > 3) {
    takeoffI = best.b; apexI = best.ai; ctMs = best.durMs; source = '反弹式触地';
  }
  if (apexI === null) {
    apexI = argMin(hipY);
    const prior = intervals.filter(([, b]) => b < apexI);
    if (prior.length) {
      const [a, b] = prior[prior.length - 1];
      takeoffI = b; ctMs = ((b - a + 1) / fps) * 1000; source = '起跳前支撑期';
    }
  }
  r.apexFrame = apexI;
  r.apexTimeS = apexI / fps;
  r.eventSource = source;

  // ---- 高度 ----
  let refY;
  if (takeoffI !== null) {
    refY = hipY[takeoffI];
    r.reference = '离地瞬间髋高（推荐）';
    r.takeoffFrame = takeoffI;
    r.takeoffTimeS = takeoffI / fps;
  } else {
    const win = Math.max(3, Math.round(0.15 * fps));
    const limit = Math.min(hipY.length, Math.round((cfg.quietS || 1.2) * fps));
    let bi = 0, bv = Infinity;
    for (let i = 0; i < Math.max(1, limit - win); i++) {
      let m = 0;
      for (let k = 0; k < win; k++) m += hipY[i + k];
      m /= win;
      let v = 0;
      for (let k = 0; k < win; k++) { const d = hipY[i + k] - m; v += d * d; }
      if (v < bv) { bv = v; bi = i; }
    }
    refY = median(hipY.slice(bi, bi + win));
    r.reference = '开头站立基线（退化方案）';
    if (mode === 'dropjump') warnings.push('落地反跳模式下没找到反弹式触地，参考点退化，跳箱高度会被错误算入。');
  }
  const heightCm = (refY - hipY[apexI]) / sc.pxPerCmV;
  r.jumpHeightCm = Number.isFinite(heightCm) ? +heightCm.toFixed(1) : null;
  if (r.jumpHeightCm !== null && r.jumpHeightCm <= 1) {
    warnings.push(`算出的跳跃高度只有 ${r.jumpHeightCm} cm，几乎没跳起来，请检查标记与标定。`);
  }

  // ---- 触地时间 / RSI ----
  if (ctMs !== null) {
    r.contactTimeMs = +ctMs.toFixed(1);
    if (ctMs <= REBOUND_MAX_CONTACT_MS) {
      if (r.jumpHeightCm) {
        r.rsi = +((r.jumpHeightCm / 100) / (ctMs / 1000)).toFixed(2);
        r.rsiNote = `触地 ${ctMs.toFixed(0)} ms，属反弹式（${source}），RSI 可比。`;
        const frameMs = 1000 / fps;
        if (frameMs > 6) {
          warnings.push(`帧率 ${fps.toFixed(0)} fps（帧间隔 ${frameMs.toFixed(1)} ms）对 ${ctMs.toFixed(0)} ms 的触地时间，` +
                        `单帧量化误差约 ${((frameMs / ctMs) * 100).toFixed(0)}%，RSI 只能当粗略估计。建议 240 fps。`);
        }
      }
    } else {
      r.rsiNote = `触地 ${ctMs.toFixed(0)} ms 超过 ${REBOUND_MAX_CONTACT_MS} ms，这是起跳前支撑期，**不构成 RSI**。`;
    }
  }
  notes.push('跳跃高度 = (离地瞬间髋高 − 顶点髋高) ÷ 竖直比例尺。');
  notes.push('触地时间 = 鞋部标记贴近地面的连续帧数 ÷ 帧率。');

  // ---- 用重力反推真实帧率 ----
  // 跳跃高度是空间测量（不受时间轴影响），腾空时间由重力唯一决定 t = sqrt(8h/g)，
  // 于是 真实帧率 = 腾空帧数 ÷ t。即使视频被转码、时间轴被拉长、或用户填错帧率，都能纠正。
  if (takeoffI !== null && r.jumpHeightCm && r.jumpHeightCm > 5) {
    const landingIv = intervals.find(([a]) => a > takeoffI);
    if (landingIv) {
      const flightFrames = landingIv[0] - takeoffI;
      if (flightFrames > 5) {
        const tReal = Math.sqrt(8 * (r.jumpHeightCm / 100) / G);
        const fpsEff = flightFrames / tReal;
        r.flightFrames = flightFrames;
        r.flightTimeRealS = +tReal.toFixed(4);
        r.fpsEffective = +fpsEff.toFixed(1);
        r.fpsDisagreementPct = +((Math.abs(fpsEff - fps) / fpsEff) * 100).toFixed(1);
        r.fpsConsistent = r.fpsDisagreementPct < 15;
      }
    }
  }
  return r;
}

/**
 * 带自动帧率校正的分析。
 *
 * 为什么不能只做一次"反推后重算"：触地时间的 400 ms 判据本身是在**假设的**时间尺度上
 * 判断的。帧率填错时，真正的反弹触地会被误判成"起跳前长支撑期"，事件识别先崩，
 * 反推也就无从启动（实测填 30 fps 时落地反跳高度直接算成 0）。
 *
 * 所以改成**自洽性搜索**：正确帧率是「由重力反推的帧率 ≈ 假设的帧率」这个不动点。
 * 在所有常见帧率里找误差最小的那个，若用户填的已经自洽就尊重用户。
 */
export function analyzeWithAutoFps(tracks, cfg) {
  const CANDIDATES = [30, 60, 120, 240, 300];
  const userRun = analyzeTracks(tracks, cfg);

  // 用户填的帧率自洽 → 直接用
  if (userRun.fpsEffective != null && userRun.fpsConsistent) {
    userRun.notes.push(
      `由跳跃腾空时间反推的真实帧率 ${userRun.fpsEffective} fps，与填写的 ${cfg.fps} fps 一致，已采用。`
    );
    return userRun;
  }

  // 否则在候选帧率里找不动点：反推值最接近假设值者胜
  let best = null;
  const tried = [];
  for (const c of CANDIDATES) {
    const r = (c === cfg.fps) ? userRun : analyzeTracks(tracks, { ...cfg, fps: c });
    if (r.fpsEffective == null) { tried.push(`${c}(无法反推)`); continue; }
    const err = Math.abs(r.fpsEffective - c) / c;
    tried.push(`${c}→${r.fpsEffective}`);
    if (!best || err < best.err) best = { c, r, err };
  }

  if (!best || best.err > 0.25) {
    userRun.warnings.unshift(
      '⚠️ 无法用重力校验帧率（没找到落地触地帧，或所有候选帧率都不自洽）。' +
      `已按你填写的 ${cfg.fps} fps 计算，请自行确认帧率正确。` +
      (tried.length ? `候选自洽性：${tried.join('、')}` : '')
    );
    return userRun;
  }

  const r = best.r;
  r.fpsUsed = best.c;
  r.fpsCandidates = tried;
  if (best.c !== cfg.fps) {
    r.warnings.unshift(
      `⚠️ 帧率与你填写的不符：你填的是 ${cfg.fps} fps，但跳跃数据只与 ${best.c} fps 自洽` +
      `（由重力反推 ${r.fpsEffective} fps）。已按 ${best.c} fps 重算。` +
      `常见原因：iPhone 转码后帧率变了，或慢动作的时间轴被拉长。`
    );
  } else {
    r.warnings.unshift(
      `⚠️ 采用你填写的 ${cfg.fps} fps，但它与重力反推的 ${r.fpsEffective} fps 有偏差，结果仅供参考。`
    );
  }
  r.notes.push(`本次使用 ${best.c} fps（由跳跃数据自洽性确定，不单纯依赖填写的帧率）。`);
  return r;
}
