/**
 * geo.js —— 定位模块
 * 对应需求文档第四章：多采样 + 离群剔除 + 精度字段强制校验 + 安全余量
 */
const Geo = {

  /** 球面距离（haversine），单位：米 */
  haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dPhi = toRad(lat2 - lat1);
    const dLam = toRad(lng2 - lng1);
    const a = Math.sin(dPhi / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLam / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * 采集定位样本并融合
   * @param {number} timeoutMs 总超时
   * @param {number} want 目标样本数
   * @param {(n:number)=>void} onSample 采点进度回调
   */
  collectSamples({ timeoutMs = 7000, want = 5, onSample } = {}) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('当前浏览器不支持地理定位'));
        return;
      }
      const samples = [];
      let finished = false;
      let watchId = null;
      let timer = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        if (!samples.length) {
          reject(new Error('未能获取定位信号，请移至室外开阔处后重试'));
          return;
        }
        resolve(Geo._fuse(samples));
      };

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const s = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          };
          samples.push(s);
          onSample && onSample(samples.length, s);
          if (samples.length >= want) finish();
        },
        (err) => {
          if (!samples.length) {
            finished = true;
            clearTimeout(timer);
            const msg = err.code === 1
              ? '定位权限被拒绝，请在浏览器设置中允许位置访问'
              : err.code === 3 ? '定位超时，请移至开阔处重试' : '定位不可用';
            reject(new Error(msg));
          }
          // 已有样本时错误码不致命，继续等后续回调直到总超时
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
      timer = setTimeout(finish, timeoutMs);
    });
  },

  /** 中位数 + 离群剔除（>50m）+ 按精度加权平均 */
  _fuse(samples) {
    const med = (arr) => {
      const a = [...arr].sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const medLat = med(samples.map((s) => s.lat));
    const medLng = med(samples.map((s) => s.lng));
    let inliers = samples.filter(
      (s) => Geo.haversine(s.lat, s.lng, medLat, medLng) <= 50
    );
    if (!inliers.length) inliers = samples;

    const weights = inliers.map((s) => 1 / (s.accuracy + 1));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const lat = inliers.reduce((sum, s, i) => sum + s.lat * weights[i], 0) / totalW;
    const lng = inliers.reduce((sum, s, i) => sum + s.lng * weights[i], 0) / totalW;
    const accuracy = Math.min(...inliers.map((s) => s.accuracy));

    let method = '网络定位';
    if (accuracy <= 20) method = 'GPS 高精度';
    else if (accuracy <= 60) method = 'GPS/Wi-Fi 融合';
    return { lat, lng, accuracy, method, sampleCount: samples.length };
  },

  /**
   * 范围判定（含安全余量）
   * effectiveRadius = radius - (accuracy * 0.5 + 10)
   */
  checkRange(point, post) {
    const distance = Geo.haversine(point.lat, point.lng, post.lat, post.lng);
    const buffer = point.accuracy * 0.5 + 10;
    const effectiveRadius = Math.max(0, (post.radius || 100) - buffer);
    return {
      distance: Math.round(distance * 10) / 10,
      radius: post.radius || 100,
      effectiveRadius: Math.round(effectiveRadius * 10) / 10,
      margin: Math.round((effectiveRadius - distance) * 10) / 10,
      inRange: distance <= effectiveRadius,
    };
  },
};

/** 简易设备指纹（UA + 屏幕 + 时区） */
function deviceFingerprint() {
  const raw = [
    navigator.userAgent,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    navigator.language,
    new Date().getTimezoneOffset(),
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  ].join('|');
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (h << 5) - h + raw.charCodeAt(i);
    h |= 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8).toUpperCase();
}

/** 考勤时间判定（含 5 分钟宽限；支持跨零点夜班） */
function judgeTimeState(type, post, now = new Date()) {
  if (!post || !post.shiftStart || !post.shiftEnd) return 'ON_TIME';
  const [sh, sm] = post.shiftStart.split(':').map(Number);
  const [eh, em] = post.shiftEnd.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return 'ON_TIME';
  const start = new Date(now); start.setHours(sh, sm, 0, 0);
  const end = new Date(now); end.setHours(eh, em, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1); // 夜班跨天
  const GRACE = 5 * 60 * 1000;
  if (type === 'CLOCK_IN') return now.getTime() > start.getTime() + GRACE ? 'LATE' : 'ON_TIME';
  return now.getTime() < end.getTime() - GRACE ? 'EARLY' : 'ON_TIME';
}
