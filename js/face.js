/**
 * face.js —— 人脸识别模块（face-api.js / TinyFaceDetector + 68 关键点 + 128维特征）
 * 对应需求文档第三章：人脸检测 → 活体检测（眨眼/张嘴随机动作）→ 特征提取 → 1:N 比对
 */
const Face = {
  modelUrl: 'lib/weights',
  loaded: false,

  async load(onStep) {
    if (this.loaded) return;
    const tiny = faceapi.nets.tinyFaceDetector;
    onStep && onStep('加载人脸检测模型…');
    await tiny.loadFromUri(this.modelUrl);
    onStep && onStep('加载人脸关键点模型…');
    await faceapi.nets.faceLandmark68Net.loadFromUri(this.modelUrl);
    onStep && onStep('加载人脸特征模型…');
    await faceapi.nets.faceRecognitionNet.loadFromUri(this.modelUrl);
    this.loaded = true;
  },

  /** 轻量检测（活体循环用）：返回多脸 + 关键点 */
  async detectLandmarks(input) {
    return faceapi.detectAllFaces(
      input,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 })
    ).withFaceLandmarks();
  },

  /** 单帧全量检测：关键点 + 128 维 descriptor，要求恰好一张人脸 */
  async detectWithDescriptor(input) {
    const list = await faceapi
      .detectAllFaces(
        input,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 480, scoreThreshold: 0.5 })
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
    return list;
  },

  /**
   * 动作活体检测：随机要求「眨眼」或「张嘴」，防照片/视频翻拍
   * @returns {Promise<{action:string}>}
   */
  async liveness(video, { onHint, onFrame, signal } = {}) {
    const action = Math.random() < 0.5 ? 'blink' : 'mouth';
    const deadline = Date.now() + 9000;
    let phase = 'baseline';
    let hits = 0;
    let lastMsg = '';
    const say = (m) => { if (m !== lastMsg) { lastMsg = m; onHint && onHint(m); } };

    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw new Error('已取消');
      const list = await Face.detectLandmarks(video);
      onFrame && onFrame(list);
      if (!list.length) { say('请将面部置于取景框内'); await sleep(140); continue; }
      if (list.length > 1) { say('检测到多张人脸，请单人打卡'); await sleep(140); continue; }

      const lm = list[0].landmarks;
      const ear = Face._eyeAspectRatio(lm);
      const mar = Face._mouthAspectRatio(lm);

      if (action === 'blink') {
        if (phase === 'baseline') {
          if (ear > 0.27) { phase = 'act'; say('请缓慢眨一下眼'); }
          else say('请睁眼正对屏幕');
        } else if (ear < 0.20) {
          if (++hits >= 2) return { action: 'blink' };
        } else if (hits > 0) {
          hits = 0;
        }
      } else {
        if (phase === 'baseline') {
          if (mar < 0.32) { phase = 'act'; say('请自然张一下嘴'); }
          else say('请闭嘴正对屏幕');
        } else if (mar > 0.5) {
          if (++hits >= 2) return { action: 'mouth' };
        } else if (hits > 0) {
          hits = 0;
        }
      }
      await sleep(110);
    }
    throw new Error('活体检测超时，请按屏幕提示完成动作');
  },

  /**
   * 1:N 人脸比对
   * @returns {{employee, distance, score, level}|{distance:number,level:'REJECT'}}
   * distance ≤ 0.50 高可信；≤ 0.60 通过；≤ 0.65 转人工；更大拒绝
   */
  match(descriptor, employees) {
    let best = null;
    let bestDist = Infinity;
    employees.forEach((emp) => {
      (emp.descriptors || []).forEach((arr) => {
        const d = faceapi.euclideanDistance(descriptor, new Float32Array(arr));
        if (d < bestDist) { bestDist = d; best = emp; }
      });
    });
    const score = Math.max(0, Math.round((1 - Math.min(bestDist, 1)) * 100));
    let level = 'REJECT';
    if (bestDist <= 0.5) level = 'PASS';
    else if (bestDist <= 0.6) level = 'PASS';
    else if (bestDist <= 0.65) level = 'REVIEW';
    return best
      ? { employee: best, distance: Math.round(bestDist * 1000) / 1000, score, level }
      : { distance: null, score: 0, level: 'REJECT' };
  },

  /** 眼睛纵横比（EAR），低于阈值视为闭眼 */
  _eyeAspectRatio(lm) {
    const ear = (pts) => {
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      return (d(pts[1], pts[5]) + d(pts[2], pts[4])) / (2 * d(pts[0], pts[3]) || 1e-6);
    };
    const p = lm.positions;
    return (ear(p.slice(36, 42)) + ear(p.slice(42, 48))) / 2;
  },

  /** 嘴部纵横比（MAR），高于阈值视为张嘴 */
  _mouthAspectRatio(lm) {
    const p = lm.positions;
    const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
    return (d(62, 66) + d(63, 65)) / (2 * d(60, 64) || 1e-6);
  },
};

/** 打开摄像头 */
async function openCamera(facingMode = 'user') {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前环境不支持摄像头调用（请通过 http://localhost 访问）');
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

/** 从 video 抓帧 → 压缩 JPEG dataURL（宽度 480） */
function snapshot(video, quality = 0.85, maxWidth = 480) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(1, maxWidth / vw);
  const c = document.createElement('canvas');
  c.width = Math.round(vw * scale);
  c.height = Math.round(vh * scale);
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1); // 前置镜像还原
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
