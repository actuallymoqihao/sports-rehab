/**
 * 浏览器端视频取帧。
 *
 * 关键设计决定：
 *  - **不让用户开摄像头**。网页 getUserMedia 拿不到 120/240 fps，慢动作是相机 app 的原生能力。
 *    所以流程是「用系统相机拍 → 选文件进来」。副作用是：不需要摄像头权限，也就不需要 HTTPS。
 *  - **逐帧流式处理**。960 帧 × 1080p RGBA 约 2 GB，一次性读入手机必崩，所以用异步生成器。
 *  - **帧率由用户填**。浏览器不暴露视频帧率，而自动探测会被显示器刷新率骗到
 *    （240 fps 的片子在 60 Hz 屏上播放，观察到的帧间隔是 1/60 s，会误判成 60 fps）。
 */

/** 打开视频文件，返回 metadata。格式不支持时抛出可读的错误。 */
export function openVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.src = url;

    const fail = (msg) => { URL.revokeObjectURL(url); reject(new Error(msg)); };
    const timer = setTimeout(() => fail('读取视频超时。若是 iPhone 的 HEVC 慢动作，请先在相册里导出为「最兼容」格式再试。'), 20000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      if (!video.videoWidth) return fail('视频没有有效画面尺寸，可能编码不受支持。');
      resolve({ video, url, duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => {
      clearTimeout(timer);
      fail('浏览器无法解码这个视频。iPhone 慢动作常是 HEVC 编码，请先在相册导出为 H.264/「最兼容」格式。');
    };
  });
}

export function closeVideo(handle) {
  try { URL.revokeObjectURL(handle.url); } catch { /* ignore */ }
}

/**
 * 逐帧产出 RGBA 帧。
 * 用「跳转 + 绘制」而不是播放捕获，是为了**确定性**：每个帧号都会被取到，不会因设备慢而丢帧。
 */
export async function* framesFromVideo(handle, { fps, targetWidth = 540, onProgress, canvas } = {}) {
  const { video } = handle;
  const total = Math.max(1, Math.floor(handle.duration * fps));
  const scale = Math.min(1, targetWidth / handle.width);
  const w = Math.max(16, Math.round(handle.width * scale));
  const h = Math.max(16, Math.round(handle.height * scale));

  const cv = canvas || document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  for (let i = 0; i < total; i++) {
    const t = i / fps;
    if (Math.abs(video.currentTime - t) > 1e-6) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; video.removeEventListener('seeked', finish); resolve(); } };
        video.addEventListener('seeked', finish);
        video.currentTime = t;
        setTimeout(finish, 400); // 某些浏览器 seek 到同一帧不触发事件
      });
    }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    if (onProgress) onProgress(i + 1, total);
    yield { data: img.data, width: w, height: h, index: i, time: t };
  }
}

/**
 * 探测视频的**真实帧率**。
 *
 * 为什么必须做：iPhone 相册里的慢动作是 240 fps，但经网页文件选择器传入时，
 * iOS 有可能把它转码成 30 fps 的普通视频（慢动作已经"烘"进画面）。
 * 这种情况下如果还按 240 去算，时间尺度会差 8 倍，RSI 直接报废。
 *
 * 原理：把播放速度降到 0.25x 再播放——此时 240 fps 的内容只需每秒呈现 60 帧，
 * 浏览器跟得上，于是能观察到真正相邻帧的 mediaTime 间隔。取**最小正间隔**即为帧周期。
 *
 * 注意：这条路径依赖 requestVideoFrameCallback，无法在无浏览器环境下验证，
 * 因此结果只作**提示**，最终仍以用户确认为准。
 */
export async function probeFps(handle, { maxMs = 2500, maxSamples = 150 } = {}) {
  const { video } = handle;
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return { ok: false, reason: '这个浏览器不支持帧回调，请手动确认帧率' };
  }
  const prevRate = video.playbackRate;
  const prevMuted = video.muted;
  const times = [];

  try {
    video.muted = true;
    video.playbackRate = 0.25;
    video.currentTime = 0;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; video.removeEventListener('seeked', fin); resolve(); } };
      video.addEventListener('seeked', fin);
      setTimeout(fin, 500);
    });

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; try { video.pause(); } catch { /* noop */ } resolve(); } };
      const cb = (_now, meta) => {
        if (typeof meta?.mediaTime === 'number') times.push(meta.mediaTime);
        if (times.length >= maxSamples) return finish();
        video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
      setTimeout(finish, maxMs);
      video.play().catch(() => finish());
    });
  } finally {
    try { video.playbackRate = prevRate; video.muted = prevMuted; video.pause(); } catch { /* noop */ }
  }

  const uniq = [...new Set(times)].sort((a, b) => a - b);
  if (uniq.length < 5) return { ok: false, reason: '只采到很少的帧，无法判断帧率', samples: uniq.length };

  let minDelta = Infinity;
  for (let i = 1; i < uniq.length; i++) {
    const d = uniq[i] - uniq[i - 1];
    if (d > 1e-6 && d < minDelta) minDelta = d;
  }
  if (!Number.isFinite(minDelta)) return { ok: false, reason: '帧时间戳没有差异', samples: uniq.length };

  const rawFps = 1 / minDelta;
  // 归一到常见帧率，抵消时间戳取整误差
  const COMMON = [24, 25, 30, 48, 50, 60, 100, 120, 240, 300];
  const snapped = COMMON.reduce((a, b) => (Math.abs(b - rawFps) < Math.abs(a - rawFps) ? b : a), COMMON[0]);
  const errPct = Math.abs(snapped - rawFps) / snapped * 100;
  return {
    ok: true, fps: snapped, rawFps: +rawFps.toFixed(2), samples: uniq.length,
    confident: errPct < 8,
    note: errPct < 8 ? '' : `实测 ${rawFps.toFixed(1)} fps，与常见帧率都不吻合，请手动核对`,
  };
}

/** 取单帧用于预览，确认标记贴对了位置 */
export async function grabPreview(handle, time, canvas) {
  const { video } = handle;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; video.removeEventListener('seeked', finish); resolve(); } };
    video.addEventListener('seeked', finish);
    video.currentTime = Math.min(time, Math.max(0, handle.duration - 0.01));
    setTimeout(finish, 400);
  });
  const scale = Math.min(1, 720 / handle.width);
  canvas.width = Math.round(handle.width * scale);
  canvas.height = Math.round(handle.height * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
}
