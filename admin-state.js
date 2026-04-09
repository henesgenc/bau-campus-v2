// ── Paylaşılan state ve yardımcı fonksiyonlar ──────────────────────────────

export const $ = id => document.getElementById(id);

export let campuses = [];
export let blocks = [];
export let classrooms = [];
export let classroomTypes = [];
export let blockFloors = [];
export let settings = {};
export let currentTab = 'campuses';
export let modalType = null;
export let editingId = null;
export let currentImageObject = null;
export let currentImages = [];
export let currentThumbnailIndex = 0;

export function setState(key, value) {
  stateMap[key](value);
}

// Setter fonksiyonları (diğer modüller import edip kullanır)
const stateMap = {
  campuses:             v => { campuses = v; },
  blocks:               v => { blocks = v; },
  classrooms:           v => { classrooms = v; },
  classroomTypes:       v => { classroomTypes = v; },
  blockFloors:          v => { blockFloors = v; },
  settings:             v => { settings = v; },
  currentTab:           v => { currentTab = v; },
  modalType:            v => { modalType = v; },
  editingId:            v => { editingId = v; },
  currentImageObject:   v => { currentImageObject = v; },
  currentImages:        v => { currentImages = v; },
  currentThumbnailIndex:v => { currentThumbnailIndex = v; },
};

// Getter fonksiyonlar — her zaman güncel değeri döner
// (import { classrooms } binding'i setState sonrası güncellenmediği için bunu kullan)
export function getClassrooms()  { return classrooms; }
export function getBlocks()      { return blocks; }
export function getCampuses()    { return campuses; }
export function getBlockFloors() { return blockFloors; }
export function getSettings()    { return settings; }
export function getClassroomTypes() { return classroomTypes; }

export function showStatus(el, text, type = 'success') {
  el.textContent = text;
  el.className = `status show ${type}`;
}

export function clearStatus(el) {
  el.textContent = '';
  el.className = 'status';
}

export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
  );
}

// Map modülünün canlı state'e erişimi için global bridge
// (ES module live binding ile çözülür; bu sadece fallback)
window.__adminState = {
  get campuses()      { return campuses; },
  get blocks()        { return blocks; },
  get classrooms()    { return classrooms; },
  get classroomTypes(){ return classroomTypes; },
  get blockFloors()   { return blockFloors; },
  get settings()      { return settings; },
};
