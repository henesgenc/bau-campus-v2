// ── admin-core.js ─────────────────────────────────────────────────────────
// Genel yardımcı fonksiyonlar, Firestore CRUD, modal, render listeleri

import { db, auth, storage } from './firebase-config.js';
import {
  collection, getDocs, getDoc, query, orderBy, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, setDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js';

import {
  $, showStatus, clearStatus, escapeHtml,
  campuses, blocks, classrooms, classroomTypes, blockFloors, settings,
  setState
} from './admin-state.js';

import { fillMapCampusFilter, renderMapPanel, loadMapPositions, updateMapUIState } from './admin-map.js';

// ── Tab sistemi ────────────────────────────────────────────────────────────
let currentTab = 'campuses';
let modalType = null;
let editingId = null;
let currentImageObject = null;
let currentImages = [];
let currentThumbnailIndex = 0;

export function setActiveTab(tab) {
  currentTab = tab;
  setState('currentTab', tab);
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $(tab + 'Panel').classList.add('active');
  if (tab === 'map') updateMapUIState();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

// ── Storage yardımcıları ───────────────────────────────────────────────────
export async function uploadFile(path, file) {
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { url, path };
}

async function deleteImageIfPossible(obj) {
  if (obj && obj.path) {
    try { await deleteObject(ref(storage, obj.path)); } catch (e) {}
  }
}

// ── Görsel önizleme ────────────────────────────────────────────────────────
function previewSingle(targetId, obj) {
  const wrap = $(targetId);
  wrap.innerHTML = obj ? `<div class="img-box"><img src="${obj.url}" alt=""></div>` : '';
}

function previewMultiple(targetId, list) {
  const wrap = $(targetId);
  wrap.innerHTML = list.map((img, i) => `
    <div class="img-box" style="position:relative">
      <img src="${img.url}" alt="" style="${i === currentThumbnailIndex ? 'border:2.5px solid var(--primary);border-radius:9px' : ''}">
      <button type="button" data-i="${i}" class="thumb-del-btn">×</button>
      <button type="button" data-ti="${i}" class="thumb-sel-btn" title="Thumbnail yap"
        style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);
          font-size:10px;font-weight:700;white-space:nowrap;padding:2px 6px;
          border:none;border-radius:6px;cursor:pointer;
          background:${i === currentThumbnailIndex ? 'var(--primary)' : '#e2e6ed'};
          color:${i === currentThumbnailIndex ? '#fff' : '#5a6477'};">
        ${i === currentThumbnailIndex ? '★ Thumbnail' : 'Thumbnail'}
      </button>
    </div>
  `).join('');
  wrap.querySelectorAll('.thumb-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.i);
      currentImages.splice(idx, 1);
      if (currentThumbnailIndex >= currentImages.length) currentThumbnailIndex = 0;
      else if (currentThumbnailIndex > idx) currentThumbnailIndex--;
      previewMultiple(targetId, currentImages);
    });
  });
  wrap.querySelectorAll('.thumb-sel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentThumbnailIndex = Number(btn.dataset.ti);
      previewMultiple(targetId, currentImages);
    });
  });
}

// ── Yardımcı fonksiyonlar ──────────────────────────────────────────────────
export function extractFeatureList(features) {
  if (Array.isArray(features)) return features.filter(Boolean);
  if (features && typeof features === 'object') {
    if (Array.isArray(features.items)) return features.items.filter(Boolean);
    if (typeof features.items === 'string') return features.items.split(',').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

export function getClassroomFloorValue(c) {
  if (!c) return '';
  const raw = c.floor ?? c?.features?.floor ?? c?.features?.kat ?? '';
  return String(raw || '').trim();
}

function getManagedFloorsForBlock(blockId) {
  return blockFloors
    .filter(f => f.blockId === blockId)
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || (a.name || '').localeCompare(b.name || '', 'tr'));
}

function getFloorOptionsForBlock(blockId, extraValues = []) {
  const values = [];
  const seen = new Set();
  const push = v => {
    const value = String(v || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    values.push(value);
  };

  const managed = getManagedFloorsForBlock(blockId);
  if (managed.length) {
    managed.forEach(f => push(f.name));
  } else {
    const block = blocks.find(b => b.id === blockId);
    if (block && Number.isFinite(Number(block.floorCount))) {
      const count = Math.max(0, Number(block.floorCount));
      for (let f = 0; f <= count; f++) push(f === 0 ? 'Zemin Kat' : `${f}.Kat`);
    }
  }

  classrooms.filter(c => c.blockId === blockId).map(c => getClassroomFloorValue(c)).forEach(push);
  extraValues.forEach(push);

  return values.sort((a, b) => {
    const normalize = val => {
      const s = String(val || '').toLowerCase().replace(/\s/g, '');
      if (s.includes('zemin')) return 0;
      const m = s.match(/(\d+)/);
      return m ? Number(m[1]) : Number.NaN;
    };
    const na = normalize(a), nb = normalize(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b, 'tr');
  });
}

export function fillClassroomFloorSelect(blockId, selectedValue = '') {
  const sel = $('classroomFloor');
  const options = getFloorOptionsForBlock(blockId, selectedValue ? [selectedValue] : []);
  sel.innerHTML = '<option value="">Kat Seçin</option>' + options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (selectedValue && !options.includes(selectedValue)) {
    sel.innerHTML += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>`;
  }
  sel.value = selectedValue || '';
}

export function fillCampusSelect(selectId) {
  $(selectId).innerHTML = campuses.map(c => `<option value="${c.id}">${escapeHtml(c.name || '')}</option>`).join('');
}

export function fillBlockSelect(selectId, campusId) {
  const filtered = blocks.filter(b => !campusId || b.campusId === campusId);
  $(selectId).innerHTML = filtered.map(b => `<option value="${b.id}">${escapeHtml(b.name || '')}</option>`).join('');
}

// ── Modal ──────────────────────────────────────────────────────────────────
function resetModal() {
  editingId = null;
  currentImageObject = null;
  currentImages = [];
  currentThumbnailIndex = 0;
  clearStatus($('modalStatus'));
  $('deleteEntityBtn').classList.add('hidden');
  ['campusForm', 'blockForm', 'classroomForm', 'floorForm'].forEach(id => $(id).classList.add('hidden'));
  ['campusImagePreview', 'blockImagePreview', 'classroomImagePreview'].forEach(id => $(id).innerHTML = '');
  ['campusName', 'campusSortOrder', 'blockName', 'blockFloorCount', 'blockSortOrder',
    'classroomCode', 'classroomCapacity', 'classroomFloor', 'classroomType',
    'classroomFeatures', 'floorName', 'floorSortOrder'].forEach(id => { if ($(id)) $(id).value = ''; });
  ['campusImage', 'blockImage', 'classroomImages'].forEach(id => { if ($(id)) $(id).value = ''; });
}

export function openModal(type, data = null) {
  resetModal();
  modalType = type;
  $('entityModal').classList.add('active');
  $('deleteEntityBtn').classList.toggle('hidden', !data);

  if (type === 'campus') {
    $('modalTitle').textContent = data ? 'Kampüs Düzenle' : 'Yeni Kampüs';
    $('campusForm').classList.remove('hidden');
    if (data) {
      editingId = data.id;
      $('campusName').value = data.name || '';
      $('campusSortOrder').value = data.sortOrder ?? '';
      currentImageObject = data.imageObject || (data.imageUrl ? { url: data.imageUrl } : null);
      previewSingle('campusImagePreview', currentImageObject);
    }
  }

  if (type === 'block') {
    fillCampusSelect('blockCampusId');
    $('modalTitle').textContent = data ? 'Blok Düzenle' : 'Yeni Blok';
    $('blockForm').classList.remove('hidden');
    if (data) {
      editingId = data.id;
      $('blockName').value = data.name || '';
      $('blockCampusId').value = data.campusId || '';
      $('blockFloorCount').value = data.floorCount || 0;
      $('blockSortOrder').value = data.sortOrder ?? '';
      currentImageObject = data.imageObject || (data.imageUrl ? { url: data.imageUrl } : null);
      previewSingle('blockImagePreview', currentImageObject);
    }
  }

  if (type === 'floor') {
    fillCampusSelect('floorCampusId');
    fillBlockSelect('floorBlockId', data?.campusId || $('floorCampusId').value);
    $('modalTitle').textContent = data ? 'Kat Düzenle' : 'Yeni Kat';
    $('floorForm').classList.remove('hidden');
    if (data) {
      editingId = data.id;
      $('floorCampusId').value = data.campusId || '';
      fillBlockSelect('floorBlockId', data.campusId);
      $('floorBlockId').value = data.blockId || '';
      $('floorName').value = data.name || '';
      $('floorSortOrder').value = data.sortOrder ?? '';
    }
  }

  if (type === 'classroom') {
    fillCampusSelect('classroomCampusId');
    fillBlockSelect('classroomBlockId', data?.campusId || $('classroomCampusId').value);
    fillClassroomFloorSelect(data?.blockId || $('classroomBlockId').value, getClassroomFloorValue(data));
    fillClassroomTypeSelect(data?.type || '');
    $('modalTitle').textContent = data ? 'Sınıf Düzenle' : 'Yeni Sınıf';
    $('classroomForm').classList.remove('hidden');
    if (data) {
      editingId = data.id;
      $('classroomCode').value = data.code || '';
      $('classroomCapacity').value = data.capacity || 0;
      $('classroomCampusId').value = data.campusId || '';
      fillBlockSelect('classroomBlockId', data.campusId);
      $('classroomBlockId').value = data.blockId || '';
      $('classroomFloor').value = getClassroomFloorValue(data);
      $('classroomType').value = data.type || '';
      $('classroomFeatures').value = extractFeatureList(data.features).join(', ');
      $('classroomActive').checked = data.active !== false;
      currentImages = Array.isArray(data.imageObjects) ? [...data.imageObjects]
        : Array.isArray(data.images) ? data.images.map(url => ({ url })) : [];
      if (data.thumbnailPath) {
        const ti = currentImages.findIndex(img => img.path === data.thumbnailPath);
        currentThumbnailIndex = ti >= 0 ? ti : 0;
      } else {
        currentThumbnailIndex = 0;
      }
      previewMultiple('classroomImagePreview', currentImages);
    }
  }
}

export function closeModal() {
  $('entityModal').classList.remove('active');
}

$('closeModal').addEventListener('click', closeModal);
$('entityModal').addEventListener('click', e => { if (e.target === $('entityModal')) closeModal(); });

// ── Event: Form select değişimleri ────────────────────────────────────────
$('floorCampusId').addEventListener('change', () => fillBlockSelect('floorBlockId', $('floorCampusId').value));
$('floorFilterCampus').addEventListener('change', () => { fillFloorFilterBlocks(); renderFloorList(); });
$('floorFilterBlock').addEventListener('change', () => renderFloorList());
$('classroomCampusId').addEventListener('change', () => {
  fillBlockSelect('classroomBlockId', $('classroomCampusId').value);
  fillClassroomFloorSelect($('classroomBlockId').value);
});
$('classroomBlockId').addEventListener('change', () =>
  fillClassroomFloorSelect($('classroomBlockId').value, $('classroomFloor').value));

$('campusImage').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (file) { currentImageObject = { url: URL.createObjectURL(file), file }; previewSingle('campusImagePreview', currentImageObject); }
});
$('blockImage').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (file) { currentImageObject = { url: URL.createObjectURL(file), file }; previewSingle('blockImagePreview', currentImageObject); }
});
$('classroomImages').addEventListener('change', e => {
  Array.from(e.target.files || []).forEach(file => currentImages.push({ url: URL.createObjectURL(file), file }));
  previewMultiple('classroomImagePreview', currentImages);
});

// ── loadAll ────────────────────────────────────────────────────────────────
export async function loadAll() {
  const [campusSnap, blockSnap, classroomSnap, typeSnap, floorSnap] = await Promise.all([
    getDocs(query(collection(db, 'campuses'), orderBy('name'))),
    getDocs(query(collection(db, 'blocks'), orderBy('name'))),
    getDocs(query(collection(db, 'classrooms'), orderBy('code'))),
    getDocs(query(collection(db, 'classroomTypes'), orderBy('name'))),
    getDocs(query(collection(db, 'blockFloors'), orderBy('sortOrder')))
  ]);

  setState('campuses', campusSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || (a.name || '').localeCompare(b.name || '', 'tr')));
  setState('blocks', blockSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || (a.name || '').localeCompare(b.name || '', 'tr')));
  setState('classrooms', classroomSnap.docs.map(d => {
    const data = { id: d.id, ...d.data() };
    data.floor = getClassroomFloorValue(data);
    data.featureList = extractFeatureList(data.features);
    return data;
  }));
  setState('classroomTypes', typeSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  setState('blockFloors', floorSnap.docs.map(d => ({ id: d.id, ...d.data() })));

  try {
    const setSnap = await getDoc(doc(db, 'settings', 'site'));
    setState('settings', setSnap.exists() ? setSnap.data() : {});
  } catch (e) { setState('settings', {}); }

  renderCounts();
  renderCampuses();
  renderBlocks();
  renderClassrooms();
  renderTypeList();
  fillFloorFilterCampuses();
  renderFloorList();
  fillSettings();
  fillClassroomTypeSelect();
  loadMapPositions();
  if (currentTab === 'map') { fillMapCampusFilter(); renderMapPanel(); }
  $('brandTitle').textContent = settings.title || 'Bahçeşehir Üniversitesi Derslikleri';
  $('brandSubtitle').textContent = settings.subtitle || 'Derslik Görselleri';
}

// ── Render fonksiyonları ───────────────────────────────────────────────────
function renderCounts() {
  $('campusCount').textContent = campuses.length;
  $('blockCount').textContent = blocks.length;
  $('classroomCount').textContent = classrooms.filter(c => c.active !== false).length;
  $('typeCount').textContent = classroomTypes.length;
  $('floorCount').textContent = blockFloors.length;
}

function renderCampuses() {
  const list = $('campusList');
  if (!campuses.length) { list.innerHTML = `<div class="empty">Henüz kampüs eklenmemiş.</div>`; return; }
  list.innerHTML = campuses.map(c => `
    <article class="item">
      <div class="item-left">
        ${c.imageUrl ? `<img class="thumb" src="${c.imageUrl}" alt="">` : `<div class="thumb placeholder">🏫</div>`}
        <div class="item-body">
          <h3 class="item-title">${escapeHtml(c.name || '')}</h3>
          <div class="item-meta">${blocks.filter(b => b.campusId === c.id).length} blok</div>
        </div>
      </div>
      <div class="item-actions">
        <button class="icon-btn edit" data-type="campus" data-id="${c.id}">✎</button>
        <button class="icon-btn delete" data-del-type="campus" data-id="${c.id}">🗑</button>
      </div>
    </article>
  `).join('');
  wireListActions();
}

function renderBlocks() {
  const list = $('blockList');
  if (!blocks.length) { list.innerHTML = `<div class="empty">Henüz blok eklenmemiş.</div>`; return; }
  list.innerHTML = blocks.map(b => `
    <article class="item">
      <div class="item-left">
        ${b.imageUrl ? `<img class="thumb" src="${b.imageUrl}" alt="">` : `<div class="thumb placeholder">🏢</div>`}
        <div class="item-body">
          <h3 class="item-title">${escapeHtml(b.name || '')}</h3>
          <div class="item-meta">${escapeHtml(b.campusName || '-')} • ${classrooms.filter(c => c.blockId === b.id).length} sınıf • ${Number(b.floorCount || 0)} kat</div>
        </div>
      </div>
      <div class="item-actions">
        <button class="icon-btn edit" data-type="block" data-id="${b.id}">✎</button>
        <button class="icon-btn delete" data-del-type="block" data-id="${b.id}">🗑</button>
      </div>
    </article>
  `).join('');
  wireListActions();
}

function renderClassrooms() {
  const q = $('classroomSearch').value.trim().toLowerCase();
  const filtered = classrooms.filter(c => {
    const text = `${c.code || ''} ${c.blockName || ''} ${getClassroomFloorValue(c) || ''} ${c.campusName || ''}`.toLowerCase();
    return text.includes(q);
  });
  const list = $('classroomList');
  if (!filtered.length) { list.innerHTML = `<div class="empty">Kayıt bulunamadı.</div>`; return; }
  list.innerHTML = filtered.map(c => `
    <article class="item" style="${c.active === false ? 'opacity:0.7;border-left:4px solid #f04438' : ''}">
      <div class="item-left">
        ${c.images?.[0] ? `<img class="thumb" src="${c.images[0]}" alt="">` : `<div class="thumb placeholder">🪑</div>`}
        <div class="item-body">
          <h3 class="item-title">${escapeHtml(c.code || '')}${c.active === false ? ' <span style="font-size:13px;font-weight:700;background:#fee4e2;color:#b42318;padding:2px 8px;border-radius:6px;margin-left:6px">Pasif</span>' : ''}</h3>
          <div class="item-meta">${escapeHtml(c.blockName || '-')} • ${escapeHtml(getClassroomFloorValue(c) || '-')} • ${Number(c.capacity || 0)} kişi</div>
        </div>
      </div>
      <div class="item-actions">
        <button class="icon-btn edit" data-type="classroom" data-id="${c.id}">✎</button>
        <button class="icon-btn delete" data-del-type="classroom" data-id="${c.id}">🗑</button>
      </div>
    </article>
  `).join('');
  wireListActions();
}

function wireListActions() {
  document.querySelectorAll('[data-type]').forEach(btn => {
    btn.onclick = () => {
      const type = btn.dataset.type, id = btn.dataset.id;
      if (type === 'campus')    openModal('campus', campuses.find(x => x.id === id));
      if (type === 'block')     openModal('block', blocks.find(x => x.id === id));
      if (type === 'classroom') openModal('classroom', classrooms.find(x => x.id === id));
      if (type === 'floor')     openModal('floor', blockFloors.find(x => x.id === id));
    };
  });
  document.querySelectorAll('[data-del-type]').forEach(btn => {
    btn.onclick = () => handleDelete(btn.dataset.delType, btn.dataset.id);
  });
}

// ── CRUD ───────────────────────────────────────────────────────────────────
async function handleDelete(type, id) {
  if (type === 'campus') {
    if (blocks.some(b => b.campusId === id)) { alert('Önce bu kampüse bağlı blokları silin.'); return; }
    const item = campuses.find(x => x.id === id);
    if (!confirm('Kampüs silinsin mi?')) return;
    await deleteImageIfPossible(item.imageObject);
    await deleteDoc(doc(db, 'campuses', id));
  }
  if (type === 'block') {
    if (classrooms.some(c => c.blockId === id)) { alert('Önce bu bloğa bağlı sınıfları silin.'); return; }
    const item = blocks.find(x => x.id === id);
    if (!confirm('Blok silinsin mi?')) return;
    await deleteImageIfPossible(item.imageObject);
    await deleteDoc(doc(db, 'blocks', id));
  }
  if (type === 'classroom') {
    const item = classrooms.find(x => x.id === id);
    if (!confirm('Sınıf silinsin mi?')) return;
    for (const img of (item.imageObjects || [])) await deleteImageIfPossible(img);
    await deleteDoc(doc(db, 'classrooms', id));
  }
  if (type === 'floor') {
    const item = blockFloors.find(x => x.id === id);
    if (!item) return;
    const used = classrooms.some(c => c.blockId === item.blockId && getClassroomFloorValue(c) === item.name);
    if (used) { alert('Bu kat sınıflarda kullanıldığı için silinemez. Önce sınıfları başka kata taşıyın.'); return; }
    if (!confirm('Kat silinsin mi?')) return;
    await deleteDoc(doc(db, 'blockFloors', id));
  }
  await loadAll();
}

async function saveCampus() {
  const name = $('campusName').value.trim();
  if (!name) return showStatus($('modalStatus'), 'Kampüs adı zorunlu.', 'error');
  let imageObject = currentImageObject && !currentImageObject.file ? currentImageObject : null;
  if (currentImageObject?.file) imageObject = await uploadFile(`campuses/${Date.now()}-${currentImageObject.file.name}`, currentImageObject.file);
  const payload = { name, sortOrder: $('campusSortOrder').value !== '' ? Number($('campusSortOrder').value) : null, imageUrl: imageObject?.url || '', imageObject, updatedAt: serverTimestamp() };
  if (editingId) {
    const old = campuses.find(x => x.id === editingId);
    if (currentImageObject?.file && old?.imageObject?.path) await deleteImageIfPossible(old.imageObject);
    await updateDoc(doc(db, 'campuses', editingId), payload);
  } else {
    payload.createdAt = serverTimestamp();
    await addDoc(collection(db, 'campuses'), payload);
  }
}

async function saveBlock() {
  const name = $('blockName').value.trim();
  const campusId = $('blockCampusId').value;
  const campus = campuses.find(c => c.id === campusId);
  if (!name || !campusId) return showStatus($('modalStatus'), 'Blok adı ve kampüs zorunlu.', 'error');
  let imageObject = currentImageObject && !currentImageObject.file ? currentImageObject : null;
  if (currentImageObject?.file) imageObject = await uploadFile(`blocks/${Date.now()}-${currentImageObject.file.name}`, currentImageObject.file);
  const payload = { name, campusId, campusName: campus?.name || '', floorCount: Number($('blockFloorCount').value || 0), sortOrder: $('blockSortOrder').value !== '' ? Number($('blockSortOrder').value) : null, imageUrl: imageObject?.url || '', imageObject, updatedAt: serverTimestamp() };
  if (editingId) {
    const old = blocks.find(x => x.id === editingId);
    if (currentImageObject?.file && old?.imageObject?.path) await deleteImageIfPossible(old.imageObject);
    await updateDoc(doc(db, 'blocks', editingId), payload);
  } else {
    payload.createdAt = serverTimestamp();
    await addDoc(collection(db, 'blocks'), payload);
  }
}

async function generateThumbnail(imageSource) {
  let objectUrl = null;
  try {
    const response = await fetch(imageSource);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    objectUrl = URL.createObjectURL(blob);
  } catch (fetchErr) { objectUrl = null; }

  const img = new Image();
  if (!objectUrl) img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = objectUrl || imageSource; });

  const TW = 400, TH = 300;
  const scale = Math.max(TW / img.naturalWidth, TH / img.naturalHeight);
  const sw = TW / scale, sh = TH / scale;
  const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = TW; canvas.height = TH;
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, TW, TH);
  const result = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  return result;
}

async function saveClassroom() {
  const code = $('classroomCode').value.trim();
  const campusId = $('classroomCampusId').value;
  const blockId = $('classroomBlockId').value;
  const campus = campuses.find(c => c.id === campusId);
  const block = blocks.find(b => b.id === blockId);
  if (!code || !campusId || !blockId) return showStatus($('modalStatus'), 'Sınıf kodu, kampüs ve blok zorunlu.', 'error');

  const saveBtn = $('saveEntityBtn');
  const oldText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Kaydediliyor...';
  showStatus($('modalStatus'), 'Kaydediliyor, lütfen bekleyin...');

  try {
    const uploaded = [];
    for (const img of currentImages) {
      if (img.file) uploaded.push(await uploadFile(`classrooms/${code}/${Date.now()}-${img.file.name}`, img.file));
      else uploaded.push(img);
    }

    let thumbnailUrl = null, thumbnailPath = null;
    const thumbSource = uploaded[currentThumbnailIndex] || uploaded[0];
    if (thumbSource) {
      showStatus($('modalStatus'), 'Thumbnail oluşturuluyor...');
      try {
        const thumbBlob = await generateThumbnail(thumbSource.url);
        const thumbPath = `classrooms/${code}/thumb_${Date.now()}.jpg`;
        const thumbObj = await uploadFile(thumbPath, thumbBlob);
        thumbnailUrl = thumbObj.url;
        thumbnailPath = thumbObj.path;
      } catch (thumbErr) { console.warn('Thumbnail oluşturulamadı, devam ediliyor:', thumbErr); }
    }

    const payload = {
      code, capacity: Number($('classroomCapacity').value || 0),
      campusId, campusName: campus?.name || '',
      blockId, blockName: block?.name || '',
      floor: $('classroomFloor').value.trim(),
      type: $('classroomType').value.trim(),
      features: { floor: $('classroomFloor').value.trim(), items: $('classroomFeatures').value.split(',').map(x => x.trim()).filter(Boolean) },
      images: uploaded.map(x => x.url), imageObjects: uploaded,
      thumbnailUrl, thumbnailPath,
      active: $('classroomActive').checked,
      updatedAt: serverTimestamp()
    };

    if (editingId) {
      const old = classrooms.find(x => x.id === editingId);
      const keptPaths = new Set(uploaded.map(x => x.path).filter(Boolean));
      for (const img of (old.imageObjects || [])) {
        if (img.path && !keptPaths.has(img.path)) await deleteImageIfPossible(img);
      }
      if (old?.thumbnailPath) await deleteImageIfPossible({ path: old.thumbnailPath });
      if (old?.brandedImagePath) await deleteImageIfPossible({ path: old.brandedImagePath });
      payload.brandedImageUrl = null;
      payload.brandedImagePath = null;
      await updateDoc(doc(db, 'classrooms', editingId), payload);
    } else {
      payload.createdAt = serverTimestamp();
      await addDoc(collection(db, 'classrooms'), payload);
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = oldText;
  }
}

async function saveSettings() {
  clearStatus($('settingsStatus'));
  const title = $('settingTitle').value.trim();
  const subtitle = $('settingSubtitle').value.trim();
  let logoObject = settings.logoObject || null;
  const file = $('settingLogo').files?.[0];
  if (file) {
    if (logoObject?.path) await deleteImageIfPossible(logoObject);
    logoObject = await uploadFile(`settings/${Date.now()}-${file.name}`, file);
  }
  await setDoc(doc(db, 'settings', 'site'), { title, subtitle, logoUrl: logoObject?.url || '', logoObject: logoObject || null, updatedAt: serverTimestamp() }, { merge: true });
  showStatus($('settingsStatus'), 'Ayarlar kaydedildi.');
  await loadAll();
}

function fillClassroomTypeSelect(selectedValue = '') {
  const select = $('classroomType');
  const options = classroomTypes.length ? classroomTypes.map(t => `<option value="${escapeHtml(t.name || '')}">${escapeHtml(t.name || '')}</option>`).join('') : '';
  select.innerHTML = `<option value="">Tür seçin</option>${options}`;
  if (selectedValue) select.value = selectedValue;
}

function renderTypeList() {
  const list = $('typeList');
  if (!list) return;
  if (!classroomTypes.length) { list.innerHTML = '<div class="empty">Henüz derslik türü eklenmemiş.</div>'; return; }
  list.innerHTML = classroomTypes.map(t => `
    <article class="item" style="min-height:auto">
      <div class="item-left">
        <div class="item-body" style="padding:16px 0">
          <h3 class="item-title" style="font-size:16px;margin:0;margin-left:14px;">${escapeHtml(t.name || '')}</h3>
        </div>
      </div>
      <div class="item-actions">
        <button class="icon-btn delete" data-type-id="${t.id}" title="Sil">🗑</button>
      </div>
    </article>
  `).join('');
  list.querySelectorAll('[data-type-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.typeId;
      const item = classroomTypes.find(x => x.id === id);
      if (!item) return;
      const used = classrooms.some(c => (c.type || '') === (item.name || ''));
      if (used) { showStatus($('typeStatus'), 'Bu tür kullanıldığı için silinemez.', 'error'); return; }
      if (!confirm('Derslik türü silinsin mi?')) return;
      await deleteDoc(doc(db, 'classroomTypes', id));
      await loadAll();
      showStatus($('typeStatus'), 'Derslik türü silindi.');
    });
  });
}

function fillFloorFilterCampuses() {
  const sel = $('floorFilterCampus');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Tüm Kampüsler</option>' + campuses.map(c => `<option value="${c.id}">${escapeHtml(c.name || '')}</option>`).join('');
  sel.value = campuses.some(c => c.id === current) ? current : '';
  fillFloorFilterBlocks();
}

function fillFloorFilterBlocks() {
  const campusId = $('floorFilterCampus').value;
  const sel = $('floorFilterBlock');
  const current = sel.value;
  const filtered = blocks.filter(b => !campusId || b.campusId === campusId);
  sel.innerHTML = '<option value="">Tüm Bloklar</option>' + filtered.map(b => `<option value="${b.id}">${escapeHtml(b.name || '')}</option>`).join('');
  sel.value = filtered.some(b => b.id === current) ? current : '';
}

function renderFloorList() {
  const list = $('floorList');
  if (!list) return;
  const campusId = $('floorFilterCampus').value;
  const blockId = $('floorFilterBlock').value;
  const filtered = blockFloors
    .filter(f => !campusId || f.campusId === campusId)
    .filter(f => !blockId || f.blockId === blockId)
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || (a.name || '').localeCompare(b.name || '', 'tr'));
  if (!filtered.length) { list.innerHTML = '<div class="empty">Henüz tanımlı kat yok.</div>'; return; }
  list.innerHTML = filtered.map(f => `
    <article class="item" style="min-height:auto">
      <div class="item-left">
        <div class="item-body">
          <h3 class="item-title">${escapeHtml(f.name || '')}</h3>
          <div class="item-meta">${escapeHtml(f.campusName || '-')} • ${escapeHtml(f.blockName || '-')} • Sıra: ${Number.isFinite(Number(f.sortOrder)) ? Number(f.sortOrder) : '-'}</div>
        </div>
      </div>
      <div class="item-actions">
        <button class="icon-btn" data-type="floor" data-id="${f.id}" title="Düzenle">✎</button>
        <button class="icon-btn delete" data-del-type="floor" data-id="${f.id}" title="Sil">🗑</button>
      </div>
    </article>
  `).join('');
  wireListActions();
}

async function saveFloor() {
  const campusId = $('floorCampusId').value;
  const blockId = $('floorBlockId').value;
  const name = $('floorName').value.trim();
  const campus = campuses.find(c => c.id === campusId);
  const block = blocks.find(b => b.id === blockId);
  if (!campusId || !blockId || !name) return showStatus($('modalStatus'), 'Kampüs, blok ve kat adı zorunlu.', 'error');
  const duplicate = blockFloors.find(f => f.blockId === blockId && (f.name || '').toLowerCase() === name.toLowerCase() && f.id !== editingId);
  if (duplicate) return showStatus($('modalStatus'), 'Bu blok için aynı kat adı zaten tanımlı.', 'error');
  const payload = { campusId, campusName: campus?.name || '', blockId, blockName: block?.name || '', name, sortOrder: $('floorSortOrder').value !== '' ? Number($('floorSortOrder').value) : null, updatedAt: serverTimestamp() };
  if (editingId) {
    const previous = blockFloors.find(f => f.id === editingId);
    await updateDoc(doc(db, 'blockFloors', editingId), payload);
    if (previous && previous.blockId === blockId && previous.name !== name) {
      const affected = classrooms.filter(c => c.blockId === blockId && getClassroomFloorValue(c) === previous.name);
      for (const room of affected) {
        await updateDoc(doc(db, 'classrooms', room.id), { floor: name, 'features.floor': name, updatedAt: serverTimestamp() });
      }
    }
  } else {
    payload.createdAt = serverTimestamp();
    await addDoc(collection(db, 'blockFloors'), payload);
  }
}

function fillSettings() {
  $('settingTitle').value = settings.title || 'Bahçeşehir Üniversitesi Derslikleri';
  $('settingSubtitle').value = settings.subtitle || 'Derslik Görselleri';
  $('settingLogoPreview').innerHTML = settings.logoUrl ? `<div class="img-box"><img src="${settings.logoUrl}" alt=""></div>` : '';
}

// ── Event listener'lar ─────────────────────────────────────────────────────
$('saveSettingsBtn').addEventListener('click', saveSettings);
$('classroomSearch').addEventListener('input', renderClassrooms);

$('activateAllBtn').addEventListener('click', async () => {
  if (!confirm('Tüm sınıflar aktif hale getirilsin mi?')) return;
  const btn = $('activateAllBtn');
  const oldText = btn.textContent;
  btn.disabled = true; btn.textContent = 'İşleniyor...';
  try {
    const inactiveClassrooms = classrooms.filter(c => c.active !== true);
    if (!inactiveClassrooms.length) { alert('Zaten tüm sınıflar aktif durumda.'); return; }
    const chunkSize = 500;
    for (let i = 0; i < inactiveClassrooms.length; i += chunkSize) {
      const batch = writeBatch(db);
      inactiveClassrooms.slice(i, i + chunkSize).forEach(c => { batch.update(doc(db, 'classrooms', c.id), { active: true }); });
      await batch.commit();
    }
    await loadAll();
    alert(`${inactiveClassrooms.length} sınıf aktif hale getirildi.`);
  } catch (e) { console.error(e); alert('İşlem sırasında hata oluştu: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = oldText; }
});

$('bulkThumbBtn').addEventListener('click', async () => {
  const pending = classrooms.filter(c => !c.thumbnailUrl && Array.isArray(c.images) && c.images.length > 0);
  if (!pending.length) { alert("Tüm derslikler zaten thumbnail'e sahip veya görseli yok."); return; }
  if (!confirm(`Thumbnail'i olmayan ${pending.length} derslik için thumbnail oluşturulsun mu? Bu işlem biraz sürebilir.`)) return;

  const modal = $('bulkThumbModal'), bar = $('bulkThumbBar'), status = $('bulkThumbStatus');
  const log = $('bulkThumbLog'), closeBtn = $('bulkThumbCloseBtn');
  bar.style.width = '0%'; log.innerHTML = ''; closeBtn.classList.add('hidden'); modal.classList.add('active');

  const addLog = (msg, color = '#344054') => {
    const line = document.createElement('div');
    line.style.color = color; line.textContent = msg;
    log.appendChild(line); log.scrollTop = log.scrollHeight;
  };

  let done = 0, succeeded = 0, failed = 0;
  for (const classroom of pending) {
    status.textContent = `İşleniyor: ${classroom.code || classroom.id} (${done + 1} / ${pending.length})`;
    try {
      const thumbBlob = await generateThumbnail(classroom.images[0]);
      const thumbPath = `classrooms/${classroom.code || classroom.id}/thumb_${Date.now()}.jpg`;
      const thumbObj = await uploadFile(thumbPath, thumbBlob);
      await updateDoc(doc(db, 'classrooms', classroom.id), { thumbnailUrl: thumbObj.url, thumbnailPath: thumbObj.path });
      const local = classrooms.find(c => c.id === classroom.id);
      if (local) { local.thumbnailUrl = thumbObj.url; local.thumbnailPath = thumbObj.path; }
      succeeded++;
      addLog(`✓ ${classroom.code || classroom.id}`, 'var(--success)');
    } catch (e) {
      failed++;
      addLog(`✗ ${classroom.code || classroom.id} — ${e.message}`, 'var(--danger)');
      console.error(classroom.code, e);
    }
    done++;
    bar.style.width = `${Math.round((done / pending.length) * 100)}%`;
  }
  status.textContent = `Tamamlandı — ${succeeded} başarılı, ${failed} hatalı`;
  addLog(`─────────────────────────────`, '#b0b9c8');
  addLog(`Toplam: ${pending.length}  ✓ ${succeeded}  ✗ ${failed}`, failed > 0 ? 'var(--danger)' : 'var(--success)');
  closeBtn.classList.remove('hidden');
});

$('bulkThumbCloseBtn').addEventListener('click', () => $('bulkThumbModal').classList.remove('active'));
$('newFloorBtn').addEventListener('click', () => openModal('floor'));
$('addTypeBtn').addEventListener('click', async () => {
  clearStatus($('typeStatus'));
  const name = $('newTypeName').value.trim();
  if (!name) return showStatus($('typeStatus'), 'Tür adı girin.', 'error');
  const exists = classroomTypes.some(t => (t.name || '').toLowerCase() === name.toLowerCase());
  if (exists) return showStatus($('typeStatus'), 'Bu tür zaten mevcut.', 'error');
  const btn = $('addTypeBtn'), oldText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Ekleniyor...';
  try {
    await addDoc(collection(db, 'classroomTypes'), { name, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    $('newTypeName').value = '';
    await loadAll();
    showStatus($('typeStatus'), 'Derslik türü eklendi.');
  } catch (e) { console.error(e); showStatus($('typeStatus'), 'Tür eklenemedi.', 'error'); }
  finally { btn.disabled = false; btn.textContent = oldText; }
});

$('newCampusBtn').addEventListener('click', () => openModal('campus'));
$('newBlockBtn').addEventListener('click', () => openModal('block'));
$('newClassroomBtn').addEventListener('click', () => openModal('classroom'));

$('saveEntityBtn').addEventListener('click', async () => {
  clearStatus($('modalStatus'));
  const btn = $('saveEntityBtn'), oldText = btn.textContent;
  try {
    if (modalType === 'campus' || modalType === 'block') { btn.disabled = true; btn.textContent = 'Kaydediliyor...'; showStatus($('modalStatus'), 'Kaydediliyor, lütfen bekleyin...'); }
    if (modalType === 'campus')    await saveCampus();
    if (modalType === 'block')     await saveBlock();
    if (modalType === 'classroom') await saveClassroom();
    if (modalType === 'floor')     await saveFloor();
    closeModal();
    await loadAll();
  } catch (e) {
    console.error(e);
    showStatus($('modalStatus'), 'Kayıt sırasında hata oluştu. Firebase yapılandırmasını ve kuralları kontrol edin.', 'error');
  } finally { btn.disabled = false; btn.textContent = oldText; }
});

$('deleteEntityBtn').addEventListener('click', async () => {
  if (!editingId || !modalType) return;
  await handleDelete(modalType, editingId);
  closeModal();
});
