/* ============================================================
 * app.js —— 应用主逻辑：打卡编排 / 记录 / 人脸底库 / 岗位配置
 * ============================================================ */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    employees: [],
    posts: [],
    records: [],
    selectedPostId: null,
    checkinType: 'CLOCK_IN',
    running: false,
    ci: { stream: null, abort: null },
    enroll: { stream: null, idx: 0, descriptors: [], photos: [] },
    postEditId: null,
    postMapApi: null,
    detailMap: null,
    device: deviceFingerprint(),
  };

  /* ---------------- 工具 ---------------- */
  const fmtDT = (ts) => {
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const fmtTime = (ts) => fmtDT(ts).slice(11);
  const dateStr = (ts = Date.now()) => fmtDT(ts).slice(0, 10);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, 2600);
  }

  function showModal(id) { $(`#${id}`).classList.remove('hidden'); }
  function hideModal(id) { $(`#${id}`).classList.add('hidden'); }
  function loading(text) {
    $('#loadingText').textContent = text || '加载中…';
    $('#loadingMask').classList.remove('hidden');
  }
  function unloading() { $('#loadingMask').classList.add('hidden'); }

  /* ---------------- 顶栏时钟 / 标签页 ---------------- */
  function tickClock() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('#topClock').innerHTML = `<b>${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}</b>
      <span>${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 星期${week}</span>`;
  }

  function showPage(name) {
    if (state.running && name !== 'checkin') cancelCheckin();
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === name));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
    if (name === 'records') renderRecords();
    if (name === 'employees') renderEmployees();
    if (name === 'posts') renderPosts();
    if (name === 'checkin') renderPostPicker();
  }

  /* ---------------- 数据加载 ---------------- */
  async function reloadAll() {
    [state.employees, state.posts, state.records] = await Promise.all([
      DB.getAll('employees'), DB.getAll('posts'), DB.getAll('records'),
    ]);
    state.records.sort((a, b) => b.time - a.time);
    if (!state.selectedPostId && state.posts[0]) state.selectedPostId = state.posts[0].id;
  }

  /* ============================================================
   * 打卡页
   * ============================================================ */
  function renderPostPicker() {
    const box = $('#ciPostList');
    if (!state.posts.length) {
      box.innerHTML = `<div class="empty"><div class="big">📍</div>暂无岗位<br/>请先到「岗位配置」新增</div>`;
    } else {
      box.innerHTML = state.posts.map((p) => `
        <div class="post-opt ${p.id === state.selectedPostId ? 'sel' : ''}" data-id="${p.id}">
          <h4>📍 ${esc(p.name)}</h4>
          <div class="meta">
            允许半径 ${p.radius}m ｜ 班次 ${p.shiftStart}–${p.shiftEnd}<br/>
            ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}
          </div>
        </div>`).join('');
      box.querySelectorAll('.post-opt').forEach((el) => {
        el.onclick = () => { state.selectedPostId = el.dataset.id; renderPostPicker(); };
      });
    }
    const note = $('#ciSideNote');
    note.innerHTML = state.employees.length
      ? `人脸底库：<b>${state.employees.length}</b> 人，打卡时将进行 1:N 身份比对。<br/>
         定位将采集 5 个 GPS 样本并剔除离群点；判定阈值含安全余量（精度×0.5+10m）。`
      : `<span style="color:#e5484d">⚠ 人脸底库为空，请先到「人员底库」录入人员。</span>`;
  }

  function resetChips() {
    $('#chipFace').className = 'vchip';
    $('#chipLoc').className = 'vchip';
    $('#chipRange').className = 'vchip';
    $('#locCount').textContent = '0/5';
    $('#ciChallenge').classList.add('hidden');
    const ctx = $('#ciOverlay').getContext('2d');
    ctx.clearRect(0, 0, $('#ciOverlay').width, $('#ciOverlay').height);
  }

  async function runCheckin() {
    const post = state.posts.find((p) => p.id === state.selectedPostId);
    if (!post) return toast('请先选择岗位', 'warn');
    if (!state.employees.length) return toast('人脸底库为空，请先录入人员', 'warn');

    state.running = true;
    const btn = $('#btnStartCheckin');
    btn.textContent = '取消打卡';
    btn.classList.remove('btn-primary');
    resetChips();
    $('#ciHint').textContent = '正在准备…';

    const ctrl = new AbortController();
    state.ci.abort = ctrl;
    let locResult = null, locError = null;

    try {
      loading('正在加载人脸识别模型（首次约需数秒）…');
      await Face.load((m) => $('#loadingText').textContent = m);
      unloading();

      /* —— 并行启动定位采点 —— */
      $('#chipLoc').className = 'vchip run';
      const geoPromise = Geo.collectSamples({
        onSample: (n) => { $('#locCount').textContent = `${n}/5`; },
      }).then((r) => { locResult = r; }).catch((e) => { locError = e; ctrl.abort(); });

      /* —— 打开摄像头 —— */
      $('#chipFace').className = 'vchip run';
      const stream = await openCamera();
      state.ci.stream = stream;
      const video = $('#ciVideo');
      video.srcObject = stream;
      await new Promise((r) => video.onloadedmetadata = r);
      await video.play();

      /* —— 活体检测 —— */
      const badge = $('#ciChallenge');
      const live = await Face.liveness(video, {
        signal: ctrl,
        onFrame: drawFaceBoxes,
        onHint: (m) => {
          $('#ciHint').textContent = m;
          if (m.includes('眨')) { badge.textContent = '👀 请眨眼'; badge.classList.remove('hidden'); }
          else if (m.includes('张嘴') || m.includes('张一下')) { badge.textContent = '👄 请张嘴'; badge.classList.remove('hidden'); }
          else badge.classList.add('hidden');
        },
      });
      badge.classList.add('hidden');
      $('#ciHint').textContent = '活体通过，正在提取人脸特征…';

      /* —— 特征提取（重试 2 次）—— */
      let dets = [];
      for (let i = 0; i < 2 && !dets.length; i++) {
        dets = await Face.detectWithDescriptor(video);
        if (!dets.length) await sleep(500);
      }
      if (!dets.length) throw { faceFail: '未能提取清晰人脸特征，请注意光线并正对摄像头' };
      if (dets.length > 1) throw { faceFail: '画面中检测到多张人脸，禁止代打卡' };

      const descriptor = dets[0].descriptor;
      const photoUrl = snapshot(video);
      const match = Face.match(descriptor, state.employees);
      $('#chipFace').className = 'vchip ok';

      /* —— 等待定位结果 —— */
      $('#ciHint').textContent = locResult ? '正在进行范围判定…' : '正在采集 GPS 定位…';
      await geoPromise;
      if (locError) throw { locFail: locError.message };
      $('#chipLoc').className = 'vchip ok';

      const range = Geo.checkRange(locResult, post);
      $('#chipRange').className = range.inRange ? 'vchip ok' : 'vchip fail';

      /* —— 汇总判定 —— */
      const now = new Date();
      const timeState = judgeTimeState(state.checkinType, post, now);
      const reasons = [];
      let status = 'SUCCESS';

      if (match.level === 'REJECT') { status = 'REJECTED'; reasons.push(`人脸比对未通过：底库无匹配人员（最高相似度 ${match.score}%）`); }
      else if (match.level === 'REVIEW') { status = 'PENDING_REVIEW'; reasons.push(`人脸相似度 ${match.score}%，处于人工复核区间（距离 ${match.distance}）`); }
      if (!range.inRange) { status = status === 'SUCCESS' ? 'REJECTED' : status; reasons.push(`不在岗位范围内：距岗位中心 ${range.distance}m，有效允许半径 ${range.effectiveRadius}m`); }

      const record = {
        id: uid('R'),
        employeeId: match.employee ? match.employee.id : null,
        employeeName: match.employee ? match.employee.name : '未识别人员',
        postId: post.id,
        postName: post.name,
        type: state.checkinType,
        time: now.getTime(),
        lat: locResult.lat,
        lng: locResult.lng,
        accuracy: locResult.accuracy,
        method: locResult.method,
        sampleCount: locResult.sampleCount,
        distance: range.distance,
        effectiveRadius: range.effectiveRadius,
        faceDistance: match.distance,
        faceScore: match.score,
        faceLevel: match.level,
        livenessAction: live.action,
        timeState,
        status,
        photoUrl,
        device: state.device,
      };
      await DB.put('records', record);
      state.records.unshift(record);

      $('#ciHint').textContent = status === 'SUCCESS' ? '打卡成功' : '打卡未通过，详见结果';
      showResult(record, reasons);
    } catch (e) {
      if (locError) {
        $('#chipLoc').className = 'vchip fail';
        showResult(null, [locError.message], true);
      } else if (e && (e.name === 'AbortError' || e.message === '已取消')) {
        toast('已取消打卡');
      } else if (e && (e.faceFail || e.locFail)) {
        const reasons = [];
        if (e.faceFail) { reasons.push(e.faceFail); $('#chipFace').className = 'vchip fail'; }
        if (e.locFail) { reasons.push(e.locFail); $('#chipLoc').className = 'vchip fail'; }
        showResult(null, reasons, true);
      } else {
        toast(e.message || '打卡失败，请重试', 'err');
        $('#ciHint').textContent = e.message || '打卡失败';
      }
    } finally {
      unloading();
      stopStream(state.ci.stream);
      state.ci.stream = null;
      state.running = false;
      btn.textContent = '开始打卡';
      btn.classList.add('btn-primary');
      const v = $('#ciVideo'); v.srcObject = null;
    }
  }

  function cancelCheckin() {
    if (state.ci.abort) state.ci.abort.abort();
    stopStream(state.ci.stream);
    state.ci.stream = null;
    state.running = false;
    const btn = $('#btnStartCheckin');
    btn.textContent = '开始打卡';
    btn.classList.add('btn-primary');
    $('#ciHint').textContent = '请选择岗位后点击「开始打卡」';
    resetChips();
  }

  function drawFaceBoxes(list) {
    const video = $('#ciVideo');
    const canvas = $('#ciOverlay');
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    list.forEach((f) => {
      ctx.strokeStyle = list.length > 1 ? '#e5484d' : '#22b36a';
      const b = f.detection.box;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
    });
  }

  function showResult(r, reasons, sysError) {
    const body = $('#resultBody');
    if (!r) {
      body.innerHTML = `
        <div class="result-hero">
          <div class="result-ico">⛔</div>
          <h2>打卡失败</h2><p>系统校验未完成，本次未生成考勤记录</p>
        </div>
        <div class="fail-reasons">${reasons.map((x) => `• ${esc(x)}`).join('<br/>')}</div>
        <div class="modal-foot"><button class="btn btn-primary" data-close="resultModal">我知道了</button></div>`;
    } else if (r.status === 'SUCCESS') {
      body.innerHTML = `
        <div class="result-hero">
          <div class="result-ico">✅</div>
          <h2>打卡成功</h2>
          <p>${esc(r.employeeName)} · ${r.type === 'CLOCK_IN' ? '上班卡' : '下班卡'} · ${fmtDT(r.time)}</p>
        </div>
        <img class="result-photo" src="${r.photoUrl}" alt="现场照片"/>
        <div class="result-grid">
          <div><div class="k">考勤状态</div><div class="v2">${timeBadge(r.timeState)}</div></div>
          <div><div class="k">活体检测</div><div class="v2">通过（${r.livenessAction === 'blink' ? '眨眼' : '张嘴'}动作）</div></div>
          <div><div class="k">人脸相似度</div><div class="v2">${r.faceScore}%</div></div>
          <div><div class="k">定位方式</div><div class="v2">${esc(r.method)} · ${r.sampleCount}点</div></div>
          <div><div class="k">定位精度</div><div class="v2">±${r.accuracy}m</div></div>
          <div><div class="k">距岗位中心</div><div class="v2">${r.distance}m（允许 ${r.effectiveRadius}m）</div></div>
          <div><div class="k">岗位</div><div class="v2">${esc(r.postName)}</div></div>
          <div><div class="k">设备指纹</div><div class="v2">${r.device}</div></div>
        </div>
        <div class="modal-foot"><button class="btn btn-primary" data-close="resultModal">完成</button></div>`;
    } else {
      body.innerHTML = `
        <div class="result-hero">
          <div class="result-ico">${r.status === 'PENDING_REVIEW' ? '🔶' : '⛔'}</div>
          <h2>${r.status === 'PENDING_REVIEW' ? '已提交人工审核' : '打卡被拒绝'}</h2>
          <p>${esc(r.employeeName)} · ${fmtDT(r.time)}</p>
        </div>
        <img class="result-photo" src="${r.photoUrl}" alt="现场照片"/>
        <div class="fail-reasons">${(reasons.length ? reasons : ['双因子校验未全部通过']).map((x) => `• ${esc(x)}`).join('<br/>')}</div>
        <div class="result-grid">
          <div><div class="k">人脸相似度</div><div class="v2">${r.faceScore}%</div></div>
          <div><div class="k">距岗位中心</div><div class="v2">${r.distance}m（允许 ${r.effectiveRadius}m）</div></div>
        </div>
        <p class="muted" style="margin-top:10px">本次尝试已留痕保存，可在「考勤记录」中查看。</p>
        <div class="modal-foot"><button class="btn btn-primary" data-close="resultModal">我知道了</button></div>`;
    }
    showModal('resultModal');
  }

  /* ============================================================
   * 考勤记录页
   * ============================================================ */
  function typeBadge(t) {
    return t === 'CLOCK_IN'
      ? '<span class="badge in">上班卡</span>'
      : '<span class="badge out">下班卡</span>';
  }
  function timeBadge(s) {
    return s === 'LATE' ? '<span class="badge red">迟到</span>'
      : s === 'EARLY' ? '<span class="badge gold">早退</span>'
        : '<span class="badge green">正常</span>';
  }
  function statusBadge(s) {
    return s === 'SUCCESS' ? '<span class="badge green">成功</span>'
      : s === 'PENDING_REVIEW' ? '<span class="badge gold">待审核</span>'
        : '<span class="badge red">已拒绝</span>';
  }

  function renderRecords() {
    // 人员下拉
    const sel = $('#fltEmployee');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部人员</option>' +
      state.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    sel.value = cur;
    if (!$('#fltDate').value) $('#fltDate').value = dateStr();

    const day = $('#fltDate').value;
    const empId = $('#fltEmployee').value;
    const type = $('#fltType').value;
    const list = state.records.filter((r) =>
      (!day || dateStr(r.time) === day) &&
      (!empId || r.employeeId === empId) &&
      (!type || r.type === type));

    // 统计（当日全部）
    const today = state.records.filter((r) => dateStr(r.time) === dateStr());
    const success = today.filter((r) => r.status === 'SUCCESS').length;
    const abnormal = today.filter((r) => r.status === 'SUCCESS' && r.timeState !== 'ON_TIME').length;
    const pending = today.filter((r) => r.status === 'PENDING_REVIEW').length;
    const rejected = today.filter((r) => r.status === 'REJECTED').length;
    $('#statRow').innerHTML = [
      ['blue', '✔', success, '今日成功打卡'],
      ['orange', '⚠', abnormal, '迟到 / 早退'],
      ['red', '🔶', pending, '待人工审核'],
      ['red', '⛔', rejected, '被拒绝尝试'],
    ].map(([c, i, v, l]) => `<div class="stat"><div class="ico ${c}">${i}</div>
      <div><div class="v">${v}</div><div class="l">${l}</div></div></div>`).join('');

    const tb = $('#recordTbody');
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="11"><div class="empty"><div class="big">📭</div>当日无打卡记录</div></td></tr>`;
      return;
    }
    tb.innerHTML = list.map((r) => `
      <tr>
        <td><img class="thumb" src="${r.photoUrl}" alt=""/></td>
        <td><b>${esc(r.employeeName)}</b></td>
        <td>${typeBadge(r.type)}</td>
        <td>${fmtDT(r.time)}</td>
        <td>${esc(r.postName)}</td>
        <td>${r.distance != null ? r.distance + 'm' : '—'}</td>
        <td>${r.accuracy != null ? '±' + r.accuracy + 'm' : '—'}</td>
        <td>${r.faceScore != null ? r.faceScore + '%' : '—'}</td>
        <td>${timeBadge(r.timeState)}</td>
        <td>${statusBadge(r.status)}</td>
        <td><button class="btn btn-sm" data-detail="${r.id}">详情</button></td>
      </tr>`).join('');
    tb.querySelectorAll('[data-detail]').forEach((b) => {
      b.onclick = () => openDetail(b.dataset.detail);
    });
  }

  function openDetail(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    const post = state.posts.find((p) => p.id === r.postId);
    $('#detailBody').innerHTML = `
      <div style="display:grid;grid-template-columns:280px 1fr;gap:18px">
        <div>
          <img src="${r.photoUrl}" style="width:100%;border-radius:10px;border:1px solid var(--border)"/>
          <div style="margin-top:12px">${typeBadge(r.type)} ${timeBadge(r.timeState)} ${statusBadge(r.status)}</div>
        </div>
        <div class="result-grid" style="grid-template-columns:1fr">
          <div><div class="k">姓名</div><div class="v2">${esc(r.employeeName)}</div></div>
          <div><div class="k">岗位</div><div class="v2">${esc(r.postName)}</div></div>
          <div><div class="k">打卡时间</div><div class="v2">${fmtDT(r.time)}</div></div>
          <div><div class="k">活体动作</div><div class="v2">${r.livenessAction === 'blink' ? '眨眼' : '张嘴'}（通过）</div></div>
          <div><div class="k">人脸相似度 / 特征距离</div><div class="v2">${r.faceScore}% / ${r.faceDistance ?? '—'}</div></div>
          <div><div class="k">定位方式</div><div class="v2">${esc(r.method || '—')}（${r.sampleCount || 0} 个样本）</div></div>
          <div><div class="k">打卡坐标</div><div class="v2">${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}（±${r.accuracy}m）</div></div>
          <div><div class="k">距岗位中心 / 有效半径</div><div class="v2">${r.distance}m / ${r.effectiveRadius}m</div></div>
          <div><div class="k">设备指纹</div><div class="v2">${r.device}</div></div>
        </div>
      </div>
      <div class="detail-map" id="detailMap"></div>
      <div class="modal-foot"><button class="btn btn-primary" data-close="detailModal">关闭</button></div>`;
    showModal('detailModal');
    if (post) {
      state.detailMap = MapUI.viewer($('#detailMap'), {
        postLat: post.lat, postLng: post.lng, radius: post.radius,
        pointLat: r.lat, pointLng: r.lng,
      });
    }
  }

  /* ============================================================
   * 人员底库：录入（三角度 + descriptor）
   * ============================================================ */
  const SHOT_GUIDES = ['第 1 张 · 正面：请正对摄像头', '第 2 张 · 左侧 15°：头微向左转', '第 3 张 · 右侧 15°：头微向右转'];

  function renderEmployees() {
    const box = $('#empGrid');
    if (!state.employees.length) {
      box.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">👤</div>
        底库为空，点击右上角「录入新人员」开始采集人脸</div>`;
      return;
    }
    box.innerHTML = state.employees.map((e) => `
      <div class="emp-card">
        <img src="${e.photoUrl}" alt=""/>
        <div class="info">
          <h4>${esc(e.name)}</h4>
          <p>${e.phone ? esc(e.phone) : '未登记手机号'}<br/>
          人脸样本 ${e.descriptors.length} 张 ｜ ${dateStr(e.createdAt)} 录入</p>
        </div>
        <div class="ops">
          <button class="btn btn-sm btn-danger" data-del="${e.id}">删除</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`确定删除人员「${state.employees.find((e) => e.id === b.dataset.del)?.name}」的人脸底库吗？历史记录将保留。`)) return;
        await DB.del('employees', b.dataset.del);
        await reloadAll(); renderEmployees();
        toast('已删除', 'ok');
      };
    });
  }

  function openEmpModal() {
    $('#empName').value = '';
    $('#empPhone').value = '';
    $('#empStepInfo').classList.remove('hidden');
    $('#empStepCapture').classList.add('hidden');
    showModal('empModal');
  }

  async function startEnrollCapture() {
    const name = $('#empName').value.trim();
    if (!name) return toast('请填写姓名', 'warn');
    if (state.employees.some((e) => e.name === name)) return toast('该姓名已存在', 'warn');

    $('#empStepInfo').classList.add('hidden');
    $('#empStepCapture').classList.remove('hidden');

    loading('正在加载人脸识别模型…');
    try {
      await Face.load((m) => $('#loadingText').textContent = m);
    } finally { unloading(); }

    state.enroll = { stream: null, idx: 0, descriptors: [], photos: [] };
    state.enroll.stream = await openCamera();
    const video = $('#enVideo');
    video.srcObject = state.enroll.stream;
    await new Promise((r) => video.onloadedmetadata = r);
    await video.play();
    $('#enHint').textContent = '摄像头就绪';
    refreshEnrollUI();
  }

  function refreshEnrollUI() {
    const { idx } = state.enroll;
    $('#enGuide').textContent = idx < 3 ? SHOT_GUIDES[idx] : '三张照片采集完成';
    const btn = $('#btnEnCapture');
    if (idx < 3) {
      btn.textContent = `拍摄第 ${idx + 1} 张`;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
    $('#btnEnRetake').classList.toggle('hidden', idx === 0);
    $('#btnEnSave').classList.toggle('hidden', idx !== 3);
    $$('.shot-slot').forEach((s, i) => s.classList.toggle('done', i < idx));
  }

  async function enrollShot() {
    const { idx } = state.enroll;
    if (idx >= 3) return;
    $('#enHint').textContent = '检测人脸中…';
    const dets = await Face.detectWithDescriptor($('#enVideo'));
    if (!dets.length) { $('#enHint').textContent = '未检测到人脸，请正对摄像头'; return; }
    if (dets.length > 1) { $('#enHint').textContent = '检测到多张人脸，请单人采集'; return; }

    const url = snapshot($('#enVideo'));
    state.enroll.descriptors.push(Array.from(dets[0].descriptor));
    state.enroll.photos.push(url);

    // 绘制到对应槽位
    const slot = $$('.shot-slot')[idx];
    const canvas = slot.querySelector('canvas');
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = url;
    slot.classList.add('done');

    state.enroll.idx++;
    $('#enHint').textContent = '采集成功';
    refreshEnrollUI();
  }

  async function retakeEnroll() {
    state.enroll.idx = 0;
    state.enroll.descriptors = [];
    state.enroll.photos = [];
    $$('.shot-slot').forEach((s) => {
      s.classList.remove('done');
      const c = s.querySelector('canvas');
      c.width = 10; c.height = 10; c.getContext('2d').clearRect(0, 0, 10, 10);
    });
    if (!state.enroll.stream) {
      state.enroll.stream = await openCamera();
      $('#enVideo').srcObject = state.enroll.stream;
      await $('#enVideo').play();
    }
    refreshEnrollUI();
  }

  async function saveEmployee() {
    const emp = {
      id: uid('E'),
      name: $('#empName').value.trim(),
      phone: $('#empPhone').value.trim(),
      descriptors: state.enroll.descriptors,
      photoUrl: state.enroll.photos[0],
      createdAt: Date.now(),
    };
    await DB.put('employees', emp);
    await reloadAll();
    closeEmpModal();
    renderEmployees();
    toast(`人员「${emp.name}」录入成功`, 'ok');
  }

  function closeEmpModal() {
    stopStream(state.enroll.stream);
    state.enroll.stream = null;
    hideModal('empModal');
  }

  /* ============================================================
   * 岗位配置：地图选点 + 半径 + 班次
   * ============================================================ */
  const DEFAULT_LAT = 39.908722, DEFAULT_LNG = 116.397496;

  function renderPosts() {
    const box = $('#postGrid');
    if (!state.posts.length) {
      box.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">📍</div>
        暂无岗位，点击右上角「新增岗位」在地图上标注</div>`;
      return;
    }
    box.innerHTML = state.posts.map((p) => `
      <div class="pcard">
        <h4>📍 ${esc(p.name)}</h4>
        <div class="kv">
          中心坐标：<b>${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</b><br/>
          允许半径：<b>${p.radius} 米</b>（有效判定含 GPS 余量）<br/>
          班次时间：<b>${p.shiftStart} – ${p.shiftEnd}</b>
        </div>
        <div class="foot">
          <button class="btn btn-sm" data-edit="${p.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-pdel="${p.id}">删除</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openPostModal(b.dataset.edit));
    box.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
      const p = state.posts.find((x) => x.id === b.dataset.pdel);
      if (!confirm(`确定删除岗位「${p.name}」吗？`)) return;
      await DB.del('posts', p.id);
      await reloadAll(); renderPosts(); renderPostPicker();
      toast('岗位已删除', 'ok');
    });
  }

  function openPostModal(id) {
    state.postEditId = id || null;
    $('#postModalTitle').textContent = id ? '编辑岗位' : '新增岗位';
    const p = id ? state.posts.find((x) => x.id === id) : null;
    $('#postName').value = p ? p.name : '';
    $('#postRadius').value = p ? p.radius : 100;
    $('#postRadiusVal').textContent = (p ? p.radius : 100) + ' m';
    $('#postShiftStart').value = p ? p.shiftStart : '08:00';
    $('#postShiftEnd').value = p ? p.shiftEnd : '18:00';
    $('#postLat').value = p ? p.lat : DEFAULT_LAT;
    $('#postLng').value = p ? p.lng : DEFAULT_LNG;
    showModal('postModal');

    setTimeout(() => {
      if (state.postMapApi) { state.postMapApi.destroy(); state.postMapApi = null; }
      state.postMapApi = MapUI.picker($('#postMap'), {
        lat: +$('#postLat').value,
        lng: +$('#postLng').value,
        radius: +$('#postRadius').value,
        onChange: (la, ln) => {
          $('#postLat').value = la.toFixed(6);
          $('#postLng').value = ln.toFixed(6);
        },
      });
    }, 80);
  }

  function closePostModal() {
    if (state.postMapApi) { state.postMapApi.destroy(); state.postMapApi = null; }
    hideModal('postModal');
  }

  async function savePost() {
    const name = $('#postName').value.trim();
    const lat = parseFloat($('#postLat').value);
    const lng = parseFloat($('#postLng').value);
    const radius = parseInt($('#postRadius').value, 10);
    if (!name) return toast('请填写岗位名称', 'warn');
    if (Number.isNaN(lat) || Number.isNaN(lng)) return toast('请填写正确的经纬度', 'warn');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return toast('经纬度超出范围', 'warn');

    const post = {
      id: state.postEditId || uid('P'),
      name, lat, lng, radius,
      shiftStart: $('#postShiftStart').value || '08:00',
      shiftEnd: $('#postShiftEnd').value || '18:00',
      updatedAt: Date.now(),
    };
    if (!state.postEditId) post.createdAt = Date.now();
    await DB.put('posts', post);
    state.selectedPostId = post.id;
    await reloadAll();
    renderPosts(); renderPostPicker();
    closePostModal();
    toast('岗位已保存', 'ok');
  }

  function locateMe() {
    if (!navigator.geolocation) return toast('浏览器不支持定位', 'err');
    toast('正在获取当前位置…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        $('#postLat').value = latitude.toFixed(6);
        $('#postLng').value = longitude.toFixed(6);
        if (state.postMapApi) state.postMapApi.setCenter(latitude, longitude);
        toast('已定位到当前位置', 'ok');
      },
      () => toast('定位失败，请检查权限或改用地图点选', 'err'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /* ============================================================
   * 事件绑定 & 启动
   * ============================================================ */
  function bindEvents() {
    $('#tabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (t) showPage(t.dataset.page);
    });

    // 打卡类型切换
    $('#ciTypeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      state.checkinType = b.dataset.type;
      $$('#ciTypeSeg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
    $('#btnStartCheckin').addEventListener('click', () => {
      if (state.running) cancelCheckin();
      else runCheckin();
    });

    // 记录筛选
    ['fltDate', 'fltEmployee', 'fltType'].forEach((id) => $('#' + id).addEventListener('change', renderRecords));
    $('#btnFltReset').addEventListener('click', () => {
      $('#fltDate').value = dateStr();
      $('#fltEmployee').value = '';
      $('#fltType').value = '';
      renderRecords();
    });

    // 人员录入
    $('#btnAddEmployee').addEventListener('click', openEmpModal);
    $('#btnToCapture').addEventListener('click', () => startEnrollCapture().catch((e) => {
      toast(e.message || '摄像头启动失败', 'err'); closeEmpModal();
    }));
    $('#btnEnCapture').addEventListener('click', () => enrollShot().catch((e) => toast(e.message, 'err')));
    $('#btnEnRetake').addEventListener('click', () => retakeEnroll().catch((e) => toast(e.message, 'err')));
    $('#btnEnSave').addEventListener('click', () => saveEmployee().catch((e) => toast(e.message, 'err')));

    // 岗位
    $('#btnAddPost').addEventListener('click', () => openPostModal(null));
    $('#btnSavePost').addEventListener('click', () => savePost().catch((e) => toast(e.message, 'err')));
    $('#btnLocateMe').addEventListener('click', locateMe);
    $('#postRadius').addEventListener('input', (e) => {
      $('#postRadiusVal').textContent = e.target.value + ' m';
      if (state.postMapApi) state.postMapApi.setRadius(+e.target.value);
    });
    const syncFromInput = () => {
      const la = parseFloat($('#postLat').value), ln = parseFloat($('#postLng').value);
      if (!Number.isNaN(la) && !Number.isNaN(ln) && state.postMapApi) state.postMapApi.setCenter(la, ln);
    };
    $('#postLat').addEventListener('change', syncFromInput);
    $('#postLng').addEventListener('change', syncFromInput);

    // 通用关闭 / 详情地图销毁
    document.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn) {
        const id = closeBtn.dataset.close;
        if (id === 'empModal') closeEmpModal();
        else if (id === 'postModal') closePostModal();
        else {
          hideModal(id);
          if (id === 'detailModal' && state.detailMap) { state.detailMap.destroy(); state.detailMap = null; }
        }
      }
    });
    // 点遮罩关闭（隐私弹窗除外）
    $$('.modal-mask').forEach((m) => m.addEventListener('click', (e) => {
      if (e.target !== m || m.id === 'consentModal') return;
      if (m.id === 'empModal') return closeEmpModal();
      if (m.id === 'postModal') return closePostModal();
      m.classList.add('hidden');
      if (m.id === 'detailModal' && state.detailMap) { state.detailMap.destroy(); state.detailMap = null; }
    }));

    // 隐私授权
    $('#btnAgree').addEventListener('click', () => {
      localStorage.setItem('sec_consent', '1');
      $('#consentModal').classList.add('hidden');
    });

    // Esc 关闭弹窗（隐私授权弹窗除外）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['empModal', 'postModal', 'detailModal', 'resultModal'].forEach((id) => {
        const m = $(`#${id}`);
        if (m.classList.contains('hidden')) return;
        if (id === 'empModal') closeEmpModal();
        else if (id === 'postModal') closePostModal();
        else {
          hideModal(id);
          if (id === 'detailModal' && state.detailMap) { state.detailMap.destroy(); state.detailMap = null; }
        }
      });
    });
  }

  async function init() {
    tickClock();
    setInterval(tickClock, 1000);
    bindEvents();
    if (localStorage.getItem('sec_consent') === '1') $('#consentModal').classList.add('hidden');
    try {
      await reloadAll();
    } catch (e) {
      toast('本地数据库初始化失败：' + e.message, 'err');
    }
    renderPostPicker();
    renderRecords();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
