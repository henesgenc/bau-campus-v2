// ── admin-auth.js ─────────────────────────────────────────────────────────
// Kimlik doğrulama: giriş, çıkış, auth state takibi

import { auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';

import { $, showStatus, clearStatus } from './admin-state.js';
import { loadAll } from './admin-core.js';

$('loginBtn').addEventListener('click', async () => {
  clearStatus($('authStatus'));
  const email    = $('loginEmail').value.trim();
  const password = $('loginPassword').value;

  if (!email)    { showStatus($('authStatus'), 'Lütfen e-posta girin.', 'error'); return; }
  if (!password) { showStatus($('authStatus'), 'Lütfen şifre girin.', 'error');   return; }

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    console.error(e);
    const msg = e?.code === 'auth/invalid-email'
      ? 'Geçerli bir e-posta adresi girin.'
      : 'Giriş başarısız. E-posta/şifre veya Auth ayarlarını kontrol edin.';
    showStatus($('authStatus'), msg, 'error');
  }
});

$('logoutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (user) {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    await loadAll();
  } else {
    $('authView').classList.remove('hidden');
    $('appView').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
  }
});
