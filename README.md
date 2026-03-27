# Derslik Galerisi

Bu proje GitHub Pages'e doğrudan yüklenebilecek tek dosyalı basit bir derslik galerisi sitesidir.

## Kurulum
1. GitHub'da yeni bir repo oluştur.
2. `index.html` dosyasını repo içine yükle.
3. Repo ayarlarından **Pages** bölümüne gir.
4. Source olarak **Deploy from a branch** seç.
5. Branch olarak `main` ve folder olarak `/root` seç.
6. Kaydet.

Bir süre sonra siten şu adreste açılır:
`https://kullaniciadi.github.io/repo-adi/`

## İçerik düzenleme
`index.html` içindeki `const classrooms = [...]` alanını kendi derslik verilerinle değiştir.

## Kendi görsellerini kullanma
Şimdilik örnek görseller internetten geliyor. İstersen repo içine bir `images` klasörü açıp şunu kullan:
`images/b201-1.jpg`

Örnek:
```js
images: [
  "images/b201-1.jpg",
  "images/b201-2.jpg"
]
```
