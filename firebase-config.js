// firebase-config.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyBNBf58774uUUWjO3Hr5hDm657OpnGCHKg",
  authDomain: "bau-campus-44357.firebaseapp.com",
  projectId: "bau-campus-44357",
  storageBucket: "bau-campus-44357.firebasestorage.app",
  messagingSenderId: "963778625447",
  appId: "1:963778625447:web:706a7897fc2ad9399b8082"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
