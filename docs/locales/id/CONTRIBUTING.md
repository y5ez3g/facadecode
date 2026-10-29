# Berkontribusi ke Facade Code

Terima kasih sudah membantu. Facade Code dikembangkan secara terbuka di [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Bug dan ide

Buka sebuah [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Bantuan > Laporkan Masalah) membuka issue baru dengan versi Anda yang sudah terisi. Cari dulu di issue yang sudah ada, dan untuk bug, sebutkan:

- apa yang Anda lakukan, apa yang Anda harapkan, dan apa yang terjadi;
- versinya, dari Help > About (Bantuan > Tentang), dan sistem operasi Anda;
- untuk masalah agen, CLI agen yang mana dan versi berapa.

Kerentanan keamanan tidak dilaporkan lewat issue; lihat [`SECURITY.md`](SECURITY.md).

## Kode

Cara kerja repositori ini dijelaskan di [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): menyiapkan build, perintah untuk memeriksa perubahan, dan versi lengkap aturan di bawah ini.

- Buat branch dari `main` dengan nama `feature/<number>-<name>`.
- Merge, jangan pernah rebase: sebuah fitur masuk ke `main` dengan `--no-ff`, setelah direview.
- Kumpulkan file Facade Code di satu tempat, dan di file VS Code tambahkan hook opsional alih-alih menulis ulang logikanya, agar menggabungkan versi VS Code yang lebih baru tidak memerlukan banyak usaha.
- Setiap fitur punya sakelar, dan kalau dimatikan hasilnya VS Code standar.
- Setiap perubahan harus disertai tes.
- Gunakan bahasa Inggris untuk dokumen, komentar, dan pesan commit.

Apa yang seharusnya dilakukan setiap fitur ada di [`docs/ide/`](../../ide/). Untuk mengubah perilaku, mulailah dari spesifikasinya, atau buka issue dulu untuk mendiskusikannya.

## Lisensi

Dengan berkontribusi, Anda setuju bahwa kontribusi Anda dilisensikan di bawah [lisensi MIT](../../../LICENSE.txt) proyek ini.
