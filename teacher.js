import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, GoogleAuthProvider, signInWithPopup, signOut
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, remove, push, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const app = initializeApp(FIREBASE_CONFIG, 'teacherApp');
const auth = getAuth(app);
const db = getDatabase(app);

const CLASSES = Array.from({length:9}, (_,i) => `${i+1}반`);
let activeSession = null;
let currentQuestion = null;
let currentResponses = [];
let sessionUnsub = null;
let currentUnsub = null;
let responsesUnsub = null;
let commentsUnsub = null;
let currentComments = {};
let expandedTeacherComments = new Set();
let currentResponseView = 'cards';
let presentationView = 'cards';
let historyCache = [];
let historyClassFilter = 'all';
let presentationOpen = false;
let studentUrl = new URL('index.html', window.location.href).href;

const $ = id => document.getElementById(id);

$('loginBtn').addEventListener('click', login);
$('logoutBtn').addEventListener('click', logout);
$('modeSelect').addEventListener('change', modeChanged);
$('startQuestionBtn').addEventListener('click', startQuestion);
$('endClassBtn').addEventListener('click', endClassSession);
$('changeClassBtn').addEventListener('click', () => showClassChooser(true));
$('clearCurrentBtn').addEventListener('click', clearCurrentResponses);
$('refreshHistoryBtn').addEventListener('click', loadHistory);
$('copyLinkBtn').addEventListener('click', copyStudentLink);
$('presentationBtn').addEventListener('click', enterPresentation);
$('exitPresentationBtn').addEventListener('click', exitPresentation);
$('viewCardsBtn').addEventListener('click', () => setResponseView('cards'));
$('viewCloudBtn').addEventListener('click', () => setResponseView('cloud'));
$('presentationCardsBtn').addEventListener('click', () => setPresentationView('cards'));
$('presentationCloudBtn').addEventListener('click', () => setPresentationView('cloud')); 
document.addEventListener('keydown', e => { if (e.key === 'Escape' && presentationOpen) exitPresentation(); });

function initStaticUI() {
  CLASSES.forEach(className => {
    const btn = document.createElement('button');
    btn.className = 'class-button';
    btn.textContent = className;
    btn.addEventListener('click', () => startClassSession(className));
    $('classButtons').appendChild(btn);
  });

  ['all', ...CLASSES].forEach(className => {
    const btn = document.createElement('button');
    btn.className = 'history-filter' + (className === 'all' ? ' active' : '');
    btn.dataset.class = className;
    btn.textContent = className === 'all' ? '전체' : className;
    btn.addEventListener('click', () => setHistoryFilter(className));
    $('historyFilters').appendChild(btn);
  });

  const qrSmall = makeQrUrl(studentUrl, 240);
  const qrLarge = makeQrUrl(studentUrl, 420);
  $('qrSmall').src = qrSmall;
  $('qrPresentation').src = qrLarge;
}

function modeName(mode) {
  return ({ free:'자유 의견', agree:'찬성 · 반대', mcq:'객관식', scale:'5점 척도' })[mode] || mode || '-';
}

function makeQrUrl(url, size) {
  return `https://quickchart.io/qr?text=${encodeURIComponent(url)}&size=${size}&margin=2&ecLevel=Q&format=png`;
}

function showLoginMessage(text, type='err') {
  $('loginMsg').textContent = text || '';
  $('loginMsg').className = text ? `msg ${type}` : 'msg';
}

function showTeacherMessage(text, type='ok') {
  $('teacherMsg').textContent = text || '';
  $('teacherMsg').className = text ? `msg ${type}` : 'msg';
  if (text) setTimeout(() => { $('teacherMsg').textContent=''; $('teacherMsg').className='msg'; }, 3500);
}

async function login() {
  $('loginBtn').disabled = true;
  showLoginMessage('Google 로그인 중...', 'info');

  try {
    await setPersistence(auth, browserLocalPersistence);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);

    // questions 경로는 최종 보안 규칙에서 교사 UID만 읽을 수 있으므로 관리자 권한을 검증합니다.
    try {
      await get(ref(db, 'classes/1반/questions'));
    } catch (permissionError) {
      const uid = result.user?.uid || auth.currentUser?.uid || '';
      if (permissionError?.code === 'PERMISSION_DENIED' || permissionError?.code === 'permission-denied' || String(permissionError?.message || '').toLowerCase().includes('permission')) {
        showLoginMessage(`Google 로그인 성공. 아직 교사 권한 규칙이 적용되지 않았습니다. 교사 UID: ${uid}`, 'info');
        return;
      }
      throw permissionError;
    }

    $('login').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    showLoginMessage('');
    attachDashboard();
    await loadHistory();
  } catch (error) {
    showLoginMessage(firebaseError(error));
  } finally {
    $('loginBtn').disabled = false;
  }
}

async function logout() {
  detachDashboard();
  await signOut(auth).catch(()=>{});
  $('dashboard').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function attachDashboard() {
  detachDashboard();
  sessionUnsub = onValue(ref(db, 'system/currentSession'), snapshot => {
    const next = snapshot.val();
    activeSession = next?.active ? next : null;
    updateSessionUI();
    attachCurrentQuestion();
  }, error => showTeacherMessage(firebaseError(error), 'err'));
}

function detachDashboard() {
  if (sessionUnsub) sessionUnsub();
  if (currentUnsub) currentUnsub();
  if (responsesUnsub) responsesUnsub();
  if (commentsUnsub) commentsUnsub();
  sessionUnsub = currentUnsub = responsesUnsub = commentsUnsub = null;
  currentComments = {};
  expandedTeacherComments.clear();
}

function updateSessionUI() {
  if (!activeSession) {
    $('sessionStart').classList.remove('hidden');
    $('sessionPanel').classList.add('hidden');
    $('questionBuilder').classList.add('locked');
    $('activeClassText').textContent = '-';
    $('currentClass').textContent = '-';
    return;
  }

  $('sessionStart').classList.add('hidden');
  $('sessionPanel').classList.remove('hidden');
  $('questionBuilder').classList.remove('locked');
  $('activeClassText').textContent = activeSession.className;
}

function showClassChooser(force=false) {
  if (force && activeSession) {
    const ok = confirm(`${activeSession.className} 수업에서 다른 반으로 바꾸면 현재 학생 페이지 연결은 종료됩니다. 계속할까요?`);
    if (!ok) return;
  }
  $('sessionStart').classList.remove('hidden');
  $('sessionPanel').classList.add('hidden');
}

async function startClassSession(className) {
  try {
    const sessionId = crypto.randomUUID();
    const updates = {};

    if (activeSession?.className) {
      updates[`classes/${activeSession.className}/current/sessionActive`] = false;
    }

    updates['system/currentSession'] = {
      active: true,
      className,
      sessionId,
      startedAt: serverTimestamp()
    };
    updates[`classes/${className}/current`] = {
      active: true,
      sessionActive: true,
      waitingForQuestion: true,
      className,
      sessionId,
      questionId: '',
      question: '',
      mode: 'free',
      options: [],
      additionalEnabled: false,
      scaleMin: 1,
      scaleMax: 5,
      scaleLeftLabel: '전혀 동의하지 않음',
      scaleRightLabel: '매우 동의함',
      version: Date.now()
    };

    await update(ref(db), updates);
    currentQuestion = null;
    currentResponses = [];
    renderCurrent();
    showTeacherMessage(`${className} 수업을 시작했습니다. 첫 질문을 입력하세요.`);
  } catch (error) {
    showTeacherMessage(firebaseError(error), 'err');
  }
}

async function endClassSession() {
  if (!activeSession) return;
  const cls = activeSession.className;
  if (!confirm(`${cls} 수업을 종료할까요?\n학생 페이지의 실시간 연결도 자동으로 종료됩니다.`)) return;

  try {
    const updates = {};
    updates['system/currentSession/active'] = false;
    updates['system/currentSession/endedAt'] = serverTimestamp();
    updates[`classes/${cls}/current/sessionActive`] = false;
    updates[`classes/${cls}/current/active`] = false;
    await update(ref(db), updates);
    showTeacherMessage(`${cls} 수업을 종료했습니다.`);
  } catch (error) {
    showTeacherMessage(firebaseError(error), 'err');
  }
}

function attachCurrentQuestion() {
  if (currentUnsub) currentUnsub();
  currentUnsub = null;
  if (responsesUnsub) responsesUnsub();
  responsesUnsub = null;
  if (commentsUnsub) commentsUnsub();
  commentsUnsub = null;
  currentQuestion = null;
  currentResponses = [];
  currentComments = {};
  expandedTeacherComments.clear();
  renderCurrent();

  if (!activeSession) return;
  const currentRef = ref(db, `classes/${activeSession.className}/current`);
  currentUnsub = onValue(currentRef, snapshot => {
    const q = snapshot.val();
    if (!q || q.sessionId !== activeSession.sessionId || q.waitingForQuestion || !q.questionId) {
      currentQuestion = null;
      currentResponses = [];
      renderCurrent();
      return;
    }
    const questionChanged = currentQuestion?.questionId !== q.questionId;
    currentQuestion = q;
    renderCurrent();
    if (questionChanged) {
      attachResponses(q);
      attachComments(q);
    }
  }, error => showTeacherMessage(firebaseError(error), 'err'));
}

function attachResponses(question) {
  if (responsesUnsub) responsesUnsub();
  const responsesRef = ref(db, `classes/${question.className}/responses/${question.questionId}`);
  responsesUnsub = onValue(responsesRef, async snapshot => {
    const raw = snapshot.val() || {};
    currentResponses = Object.entries(raw).map(([uid, value]) => ({ uid, ...value }))
      .sort((a,b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
    renderCurrent();
    if (presentationOpen) renderPresentation();

    // 현재 질문의 응답 수를 질문 기록 메타데이터에 반영
    try {
      await set(ref(db, `classes/${question.className}/questions/${question.questionId}/responseCount`), currentResponses.length);
    } catch (_) {}
  }, error => showTeacherMessage(firebaseError(error), 'err'));
}

function attachComments(question) {
  if (commentsUnsub) commentsUnsub();
  const commentsRef = ref(db, `classes/${question.className}/comments/${question.questionId}`);
  commentsUnsub = onValue(commentsRef, snapshot => {
    currentComments = snapshot.val() || {};
    renderResponses();
  }, error => showTeacherMessage(firebaseError(error), 'err'));
}

function modeChanged() {
  const mode = $('modeSelect').value;
  $('mcqSettings').classList.toggle('hidden', mode !== 'mcq');
  $('scaleSettings').classList.toggle('hidden', mode !== 'scale');
  $('additionalSetting').classList.toggle('hidden', mode === 'free');
}

async function startQuestion() {
  if (!activeSession) return showTeacherMessage('먼저 수업 반을 시작해주세요.', 'err');

  const question = $('questionInput').value.trim().slice(0, 200);
  const mode = $('modeSelect').value;
  if (!question) return showTeacherMessage('질문을 입력해주세요.', 'err');

  let options = [];
  if (mode === 'agree') options = ['찬성', '반대'];
  if (mode === 'mcq') {
    options = $('optionsInput').value.split('\n').map(v => v.trim().slice(0,60)).filter(Boolean);
    options = [...new Set(options)];
    if (options.length < 2) return showTeacherMessage('객관식 선택지를 2개 이상 입력해주세요.', 'err');
    if (options.length > 8) return showTeacherMessage('객관식 선택지는 최대 8개입니다.', 'err');
  }

  if (currentResponses.length && !confirm('새 질문을 시작하면 현재 집계는 0부터 다시 시작합니다. 기존 질문과 답변은 기록에 남습니다. 계속할까요?')) return;

  const qid = push(ref(db, `classes/${activeSession.className}/questions`)).key;
  const now = new Date();
  const dateKey = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
  const questionData = {
    questionId: qid,
    className: activeSession.className,
    sessionId: activeSession.sessionId,
    question,
    mode,
    options,
    additionalEnabled: mode === 'free' ? false : $('additionalEnabled').checked,
    scaleMin: 1,
    scaleMax: 5,
    scaleLeftLabel: $('scaleLeft').value.trim().slice(0,40) || '전혀 동의하지 않음',
    scaleRightLabel: $('scaleRight').value.trim().slice(0,40) || '매우 동의함',
    dateKey,
    createdAt: serverTimestamp(),
    responseCount: 0,
    version: Date.now()
  };

  try {
    const updates = {};
    updates[`classes/${activeSession.className}/questions/${qid}`] = questionData;
    updates[`classes/${activeSession.className}/current`] = {
      ...questionData,
      active: true,
      sessionActive: true,
      waitingForQuestion: false
    };
    await update(ref(db), updates);
    showTeacherMessage('새 질문을 시작했습니다. 학생 화면도 즉시 바뀝니다.');
    await loadHistory();
  } catch (error) {
    showTeacherMessage(firebaseError(error), 'err');
  }
}

function renderCurrent() {
  const count = currentResponses.length;
  $('count').textContent = String(count);
  $('qrCount').textContent = `${count}명`;
  $('presentationCount').textContent = `${count}명`;
  $('updatedAt').textContent = `마지막 반영 ${new Date().toLocaleTimeString('ko-KR')}`;

  if (!activeSession) {
    $('currentQuestion').textContent = '수업을 시작해주세요.';
    $('currentClass').textContent = '-';
    $('currentMode').textContent = '-';
    $('summary').innerHTML = '';
    renderResponseArea();
    return;
  }

  $('currentClass').textContent = activeSession.className;
  if (!currentQuestion) {
    $('currentQuestion').textContent = '첫 질문을 기다리는 중입니다.';
    $('currentMode').textContent = '대기';
    $('summary').innerHTML = '';
    renderResponseArea();
    return;
  }

  $('currentQuestion').textContent = currentQuestion.question;
  $('currentMode').textContent = modeName(currentQuestion.mode);
  renderSummary($('summary'), currentQuestion, currentResponses);
  renderResponseArea();
  if (presentationOpen) renderPresentation();
}

function renderSummary(root, config, responses) {
  root.innerHTML = '';
  if (!config || config.mode === 'free') return;

  const box = document.createElement('div');
  box.className = 'summary-box';
  const head = document.createElement('div');
  head.className = 'summary-head';
  const title = document.createElement('div');
  title.className = 'summary-title';
  title.textContent = config.mode === 'scale' ? '5점 척도 결과' : '응답 결과';
  head.appendChild(title);

  if (config.mode === 'scale') {
    const answered = responses.filter(r => r.answer !== '');
    const avg = document.createElement('div');
    avg.className = 'average';
    avg.textContent = answered.length ? `평균 ${(answered.reduce((s,r)=>s+Number(r.answer||0),0)/answered.length).toFixed(2)}` : '평균 -';
    head.appendChild(avg);
  }
  box.appendChild(head);

  const options = config.mode === 'scale' ? ['1','2','3','4','5'] : (config.options || []);
  const counts = Object.fromEntries(options.map(o => [o, 0]));
  responses.forEach(r => { if (Object.hasOwn(counts, r.answer)) counts[r.answer]++; });

  options.forEach(option => {
    const count = counts[option] || 0;
    const pct = responses.length ? Math.round(count / responses.length * 100) : 0;
    const row = document.createElement('div'); row.className = 'bar-row';
    const label = document.createElement('div'); label.className='bar-label';
    if (config.mode === 'scale' && option === '1') label.textContent = `1 · ${config.scaleLeftLabel || ''}`;
    else if (config.mode === 'scale' && option === '5') label.textContent = `5 · ${config.scaleRightLabel || ''}`;
    else label.textContent = option;
    const track = document.createElement('div'); track.className='bar-track';
    const fill = document.createElement('div'); fill.className='bar-fill'; fill.style.width=`${pct}%`; track.appendChild(fill);
    const value = document.createElement('div'); value.className='bar-value'; value.textContent=`${count}명 · ${pct}%`;
    row.append(label, track, value); box.appendChild(row);
  });
  root.appendChild(box);
}

function setResponseView(view) {
  currentResponseView = view === 'cloud' ? 'cloud' : 'cards';
  $('viewCardsBtn').classList.toggle('active', currentResponseView === 'cards');
  $('viewCloudBtn').classList.toggle('active', currentResponseView === 'cloud');
  renderResponseArea();
}

function renderResponseArea() {
  const responseRoot = $('responses');
  const cloudRoot = $('wordCloud');
  const showCloud = currentResponseView === 'cloud';
  responseRoot.classList.toggle('hidden', showCloud);
  cloudRoot.classList.toggle('hidden', !showCloud);
  if (showCloud) renderWordCloud(cloudRoot, currentResponses, false);
  else renderResponses();
}

function renderResponses() {
  const root = $('responses');
  root.innerHTML = '';
  if (!currentResponses.length) {
    root.innerHTML = '<div class="empty">아직 제출된 응답이 없습니다.</div>';
    return;
  }

  currentResponses.forEach(item => {
    const card = document.createElement('div'); card.className='response';
    const meta = document.createElement('div'); meta.className='meta';
    const name = document.createElement('span'); name.className='name'; name.textContent=item.name || '익명';
    const time = document.createElement('span'); time.textContent=formatTime(item.submittedAt);
    meta.append(name,time); card.appendChild(meta);

    if (currentQuestion?.mode !== 'free') {
      const tag = document.createElement('div'); tag.className='answer-tag';
      tag.textContent = currentQuestion?.mode === 'scale' ? `${item.answer}점` : item.answer;
      card.appendChild(tag);
    }
    const op = document.createElement('div'); op.className='opinion';
    if (item.opinion) op.textContent=item.opinion;
    else { op.classList.add('no-extra'); op.textContent=currentQuestion?.mode==='free'?'(내용 없음)':'추가 의견 없음'; }
    card.appendChild(op);

    const comments = teacherCommentsFor(item.uid);
    const actions = document.createElement('div'); actions.className='response-actions response-actions-split';
    const commentBtn = document.createElement('button');
    commentBtn.className='comment-toggle';
    commentBtn.textContent=`댓글 ${comments.length}`;
    commentBtn.addEventListener('click', () => {
      if (expandedTeacherComments.has(item.uid)) expandedTeacherComments.delete(item.uid);
      else expandedTeacherComments.add(item.uid);
      renderResponses();
    });
    const del = document.createElement('button'); del.className='danger'; del.textContent='삭제';
    del.addEventListener('click', () => deleteResponse(item.uid));
    actions.append(commentBtn, del); card.appendChild(actions);

    if (expandedTeacherComments.has(item.uid)) {
      card.appendChild(createTeacherCommentArea(item.uid, comments));
    }
    root.appendChild(card);
  });
}

function teacherCommentsFor(responseUid) {
  const raw = currentComments?.[responseUid] || {};
  return Object.entries(raw)
    .map(([commentId, value]) => ({ commentId, ...value }))
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

function createTeacherCommentArea(responseUid, comments) {
  const area = document.createElement('div');
  area.className = 'teacher-comment-area';
  if (!comments.length) {
    area.innerHTML = '<div class="comment-empty">댓글이 없습니다.</div>';
    return area;
  }
  comments.forEach(comment => {
    const item = document.createElement('div');
    item.className = 'teacher-comment-item';
    const body = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.name || '익명';
    const time = document.createElement('span');
    time.textContent = formatTime(comment.createdAt);
    meta.append(author, time);
    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = comment.text || '';
    body.append(meta, text);
    const del = document.createElement('button');
    del.className = 'comment-delete teacher-comment-delete';
    del.textContent = '댓글 삭제';
    del.addEventListener('click', () => deleteComment(responseUid, comment.commentId));
    item.append(body, del);
    area.appendChild(item);
  });
  return area;
}

async function deleteComment(responseUid, commentId) {
  if (!currentQuestion || !commentId) return;
  if (!confirm('이 댓글을 삭제할까요?')) return;
  try {
    await remove(ref(db, `classes/${currentQuestion.className}/comments/${currentQuestion.questionId}/${responseUid}/${commentId}`));
  } catch (error) {
    showTeacherMessage(firebaseError(error), 'err');
  }
}

async function deleteResponse(uid) {
  if (!currentQuestion || !confirm('이 응답을 삭제할까요?')) return;
  try {
    const updates = {};
    updates[`classes/${currentQuestion.className}/responses/${currentQuestion.questionId}/${uid}`] = null;
    updates[`classes/${currentQuestion.className}/comments/${currentQuestion.questionId}/${uid}`] = null;
    await update(ref(db), updates);
  } catch (error) { showTeacherMessage(firebaseError(error), 'err'); }
}

async function clearCurrentResponses() {
  if (!currentQuestion || !currentResponses.length) return;
  if (!confirm(`현재 질문의 응답 ${currentResponses.length}명을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    const updates = {};
    updates[`classes/${currentQuestion.className}/responses/${currentQuestion.questionId}`] = null;
    updates[`classes/${currentQuestion.className}/comments/${currentQuestion.questionId}`] = null;
    updates[`classes/${currentQuestion.className}/questions/${currentQuestion.questionId}/responseCount`] = 0;
    await update(ref(db), updates);
  } catch (error) { showTeacherMessage(firebaseError(error), 'err'); }
}

async function loadHistory() {
  try {
    const snapshots = await Promise.all(CLASSES.map(className => get(ref(db, `classes/${className}/questions`))));
    const items = [];
    snapshots.forEach((snapshot, index) => {
      const className = CLASSES[index];
      const raw = snapshot.val() || {};
      Object.values(raw).forEach(q => items.push({ ...q, className: q.className || className }));
    });
    items.sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    historyCache = items;
    renderHistory();
  } catch (error) {
    showTeacherMessage(firebaseError(error), 'err');
  }
}

function setHistoryFilter(className) {
  historyClassFilter = className;
  document.querySelectorAll('.history-filter').forEach(btn => btn.classList.toggle('active', btn.dataset.class === className));
  renderHistory();
}

function renderHistory() {
  const root = $('historyList');
  root.innerHTML = '';
  const filtered = historyCache.filter(q => historyClassFilter === 'all' || q.className === historyClassFilter);
  $('historyCount').textContent = `${filtered.length}개 질문`;
  if (!filtered.length) {
    root.innerHTML = '<div class="history-empty">아직 저장된 질문 기록이 없습니다.</div>';
    return;
  }

  const groups = new Map();
  filtered.forEach(q => {
    const dateKey = q.dateKey || '날짜 미상';
    if (!groups.has(dateKey)) groups.set(dateKey, new Map());
    const classMap = groups.get(dateKey);
    if (!classMap.has(q.className)) classMap.set(q.className, []);
    classMap.get(q.className).push(q);
  });

  groups.forEach((classMap, dateKey) => {
    const dateHeading = document.createElement('div'); dateHeading.className='date-heading'; dateHeading.textContent=historyDateLabel(dateKey); root.appendChild(dateHeading);
    classMap.forEach((items, className) => {
      const section = document.createElement('div'); section.className='class-group';
      const head = document.createElement('div'); head.className='class-group-heading';
      head.innerHTML = `<span>${escapeHtml(className)}</span><span>${items.length}개 질문</span>`;
      section.appendChild(head);
      items.forEach(q => section.appendChild(createHistoryCard(q)));
      root.appendChild(section);
    });
  });
}

function createHistoryCard(q) {
  const card = document.createElement('div'); card.className='history-card';
  const head = document.createElement('button'); head.type='button'; head.className='history-head';
  const left = document.createElement('div');
  const title = document.createElement('div'); title.className='history-question'; title.textContent=q.question || '(질문 없음)';
  const meta = document.createElement('div'); meta.className='history-meta';
  const mode = document.createElement('span'); mode.className='badge'; mode.textContent=modeName(q.mode);
  const count = document.createElement('span'); count.className='badge gray'; count.textContent=`응답 ${q.responseCount || 0}명`;
  const time = document.createElement('span'); time.className='sub'; time.textContent=formatTime(q.createdAt);
  meta.append(mode,count,time); left.append(title,meta);
  const right = document.createElement('div'); right.className='history-head-actions';
  const toggle = document.createElement('div'); toggle.className='history-toggle'; toggle.textContent='답변 보기';
  const del = document.createElement('button'); del.type='button'; del.className='history-delete'; del.textContent='질문 기록 삭제';
  del.addEventListener('click', e => { e.stopPropagation(); deleteHistoryQuestion(q); });
  right.append(toggle,del); head.append(left,right);
  const body = document.createElement('div'); body.className='history-body';
  head.addEventListener('click', async () => {
    const opening = !card.classList.contains('open');
    card.classList.toggle('open');
    if (opening && !body.dataset.loaded) {
      body.dataset.loaded='1';
      body.innerHTML='<div class="history-empty">답변 불러오는 중...</div>';
      await loadHistoryResponses(q, body);
    }
  });
  card.append(head,body); return card;
}

async function loadHistoryResponses(q, body) {
  try {
    const [responseSnapshot, commentSnapshot] = await Promise.all([
      get(ref(db, `classes/${q.className}/responses/${q.questionId}`)),
      get(ref(db, `classes/${q.className}/comments/${q.questionId}`))
    ]);
    const responsesRaw = responseSnapshot.val() || {};
    const commentsRaw = commentSnapshot.val() || {};
    const responses = Object.entries(responsesRaw)
      .map(([uid, value]) => ({ uid, ...value }))
      .sort((a,b)=>Number(b.submittedAt||0)-Number(a.submittedAt||0));
    body.innerHTML='';
    if (q.mode !== 'free') renderSummary(body, q, responses);
    if (!responses.length) {
      const empty = document.createElement('div'); empty.className='history-empty'; empty.textContent='이 질문에는 제출된 답변이 없습니다.'; body.appendChild(empty); return;
    }
    const root = document.createElement('div'); root.className='history-responses';
    responses.forEach(r => {
      const item = document.createElement('div'); item.className='history-response';
      const meta = document.createElement('div'); meta.className='meta';
      const name = document.createElement('span'); name.className='name'; name.textContent=r.name || '익명';
      const time = document.createElement('span'); time.textContent=formatTime(r.submittedAt); meta.append(name,time); item.appendChild(meta);
      if (q.mode !== 'free') { const tag=document.createElement('div'); tag.className='answer-tag'; tag.textContent=q.mode==='scale'?`${r.answer}점`:r.answer; item.appendChild(tag); }
      const op=document.createElement('div'); op.className='opinion'; if(r.opinion) op.textContent=r.opinion; else {op.classList.add('no-extra');op.textContent=q.mode==='free'?'(내용 없음)':'추가 의견 없음';} item.appendChild(op);
      const rawComments = commentsRaw?.[r.uid] || {};
      const comments = Object.entries(rawComments).map(([commentId, value]) => ({commentId, ...value})).sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0));
      if (comments.length) {
        const cbox = document.createElement('div'); cbox.className='history-comments';
        const ctitle = document.createElement('div'); ctitle.className='history-comments-title'; ctitle.textContent=`댓글 ${comments.length}`; cbox.appendChild(ctitle);
        comments.forEach(c => {
          const ci=document.createElement('div');ci.className='history-comment';
          const cm=document.createElement('div');cm.className='comment-meta';
          const ca=document.createElement('span');ca.className='comment-author';ca.textContent=c.name||'익명';
          const ct=document.createElement('span');ct.textContent=formatTime(c.createdAt);cm.append(ca,ct);
          const cx=document.createElement('div');cx.className='comment-text';cx.textContent=c.text||'';
          ci.append(cm,cx);cbox.appendChild(ci);
        });
        item.appendChild(cbox);
      }
      root.appendChild(item);
    });
    body.appendChild(root);
  } catch (error) {
    body.innerHTML=`<div class="history-empty">${escapeHtml(firebaseError(error))}</div>`;
  }
}

async function deleteHistoryQuestion(q) {
  if (currentQuestion?.questionId === q.questionId) return showTeacherMessage('현재 진행 중인 질문은 삭제할 수 없습니다.', 'err');
  const ok = confirm(`이 질문 기록을 삭제할까요?\n\n${q.question}\n\n연결된 학생 답변과 댓글도 함께 삭제됩니다.`);
  if (!ok) return;
  try {
    const updates = {};
    updates[`classes/${q.className}/questions/${q.questionId}`] = null;
    updates[`classes/${q.className}/responses/${q.questionId}`] = null;
    updates[`classes/${q.className}/comments/${q.questionId}`] = null;
    await update(ref(db), updates);
    await loadHistory();
    showTeacherMessage('질문 기록과 연결된 답변·댓글을 삭제했습니다.');
  } catch (error) { showTeacherMessage(firebaseError(error), 'err'); }
}

function enterPresentation() {
  if (!currentQuestion) return showTeacherMessage('발표할 현재 질문이 없습니다.', 'err');
  presentationOpen = true;
  $('presentation').classList.add('open');
  renderPresentation();
  document.documentElement.requestFullscreen?.().catch(()=>{});
}

function exitPresentation() {
  presentationOpen = false;
  $('presentation').classList.remove('open');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(()=>{});
}

function setPresentationView(view) {
  presentationView = view === 'cloud' ? 'cloud' : 'cards';
  $('presentationCardsBtn').classList.toggle('active', presentationView === 'cards');
  $('presentationCloudBtn').classList.toggle('active', presentationView === 'cloud');
  if (presentationOpen) renderPresentation();
}

function renderPresentation() {
  if (!currentQuestion) return;
  $('presentationQuestion').textContent=currentQuestion.question;
  $('presentationClass').textContent=currentQuestion.className;
  $('presentationMode').textContent=modeName(currentQuestion.mode);
  $('presentationCount').textContent=`${currentResponses.length}명`;
  const root=$('presentationResult'); root.innerHTML='';
  root.classList.remove('word-cloud-host');

  if (presentationView === 'cloud') {
    renderWordCloud(root, currentResponses, true);
    return;
  }

  if (currentQuestion.mode !== 'free') {
    renderSummary(root,currentQuestion,currentResponses);
    return;
  }
  if (!currentResponses.length) {
    root.innerHTML='<div class="presentation-empty">학생 의견을 기다리는 중입니다.</div>';
    return;
  }
  const wall=document.createElement('div');
  wall.className='presentation-free';
  currentResponses.slice(0,6).forEach(r=>{
    const card=document.createElement('div');card.className='presentation-free-card';
    const meta=document.createElement('div');meta.className='presentation-free-meta';meta.textContent=`${r.name||'익명'} · ${formatTime(r.submittedAt)}`;
    const text=document.createElement('div');text.className='presentation-free-text';text.textContent=r.opinion||'(내용 없음)';
    card.append(meta,text);wall.appendChild(card);
  });
  root.appendChild(wall);
}

const WORD_STOP = new Set([
  '그리고','그러나','하지만','그래서','또한','또','정말','매우','너무','조금','그냥','저는','제가','나는','내가','우리','우리는',
  '생각','생각합니다','생각해요','생각한다','생각입니다','같다','같아요','같습니다','때문','때문에','대한','대해','통해','위해',
  '것','것은','것이','것을','것도','수','있다','있습니다','있는','없다','없습니다','한다','합니다','해야','하지','입니다','이다','된다','되는',
  '사람','학생','질문','의견','경우','부분','이런','그런','이것','그것','저것','한','할','하는','하고','하면','하여','해서','라고','이라는','라는'
]);

function renderWordCloud(root, responses, large=false) {
  root.innerHTML='';
  root.classList.add('word-cloud-host');
  const terms = buildWordTerms(responses);
  if (!terms.length) {
    const empty=document.createElement('div');
    empty.className=large?'presentation-empty':'word-cloud-empty';
    empty.textContent='워드클라우드를 만들 수 있는 서술형 의견이 아직 없습니다.';
    root.appendChild(empty);
    return;
  }

  const cloud=document.createElement('div');
  cloud.className='word-cloud-terms' + (large?' large':'');
  const max=terms[0].count;
  const min=terms[terms.length-1].count;
  const minSize=large?28:18;
  const maxSize=large?76:46;
  const spread=Math.max(1,max-min);
  const arranged=[...terms].sort((a,b)=>wordHash(a.word)-wordHash(b.word));
  arranged.forEach(term=>{
    const el=document.createElement('span');
    el.className='word-cloud-term';
    const ratio=(term.count-min)/spread;
    el.style.fontSize=`${Math.round(minSize+(maxSize-minSize)*Math.sqrt(Math.max(0,ratio)))}px`;
    el.style.fontWeight=String(Math.round(750+200*ratio));
    el.style.opacity=String(0.68+0.32*ratio);
    el.textContent=term.word;
    el.title=`${term.count}회`;
    cloud.appendChild(el);
  });
  root.appendChild(cloud);
}

function buildWordTerms(responses) {
  const freq=new Map();
  responses.forEach(r=>{
    const text=String(r.opinion||'').normalize('NFKC');
    text.split(/\s+/u).forEach(token=>{
      const word=normalizeWord(token);
      if (!word) return;
      freq.set(word,(freq.get(word)||0)+1);
    });
  });
  return [...freq.entries()]
    .map(([word,count])=>({word,count}))
    .sort((a,b)=>b.count-a.count || a.word.localeCompare(b.word,'ko'))
    .slice(0,40);
}

function normalizeWord(token) {
  let word=String(token||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if (word.length<2) return '';
  word=word.replace(/(에서는|으로는|에게는|까지는|부터는|이라는|이라는|라고|으로|에서|에게|한테|처럼|보다|하고|이며|이라|라는|은|는|을|를|도|만|와|과)$/u,'');
  if (word.length<2 || WORD_STOP.has(word)) return '';
  return word;
}

function wordHash(word) {
  let h=0;
  for (const ch of word) h=(h*31+ch.codePointAt(0))%1000003;
  return h;
}

async function copyStudentLink() {
  try { await navigator.clipboard.writeText(studentUrl); showTeacherMessage('학생용 링크를 복사했습니다.'); }
  catch (_) { prompt('학생용 링크를 복사하세요.', studentUrl); }
}

function historyDateLabel(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey;
  const [y,m,d]=dateKey.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});
}

function formatTime(value) {
  const n=Number(value||0); if(!n) return '';
  return new Date(n).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function firebaseError(error) {
  const code=error?.code||'';
  if(code.includes('auth/invalid-credential')) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if(code.includes('permission-denied')) return '이 계정은 교사용 권한이 없습니다. database.rules.json의 TEACHER_UID를 확인해주세요.';
  if(code.includes('network')) return '네트워크 연결을 확인해주세요.';
  return error?.message||String(error);
}

function escapeHtml(text) {
  return String(text??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

initStaticUI();
modeChanged();
