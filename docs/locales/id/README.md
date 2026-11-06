<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Orkestrator multi-agen untuk VS Code.**

Jalankan CLI agen native, edit kode, dan tinjau perubahan dalam jendela IDE yang sama. Gunakan akun dan langganan Anda sendiri, dan biarkan agen berkolaborasi lintas jendela dan mesin.

[![Situs web: facadecode.com](https://img.shields.io/badge/Situs%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: pasang](https://img.shields.io/badge/VS%20Code%20Marketplace-pasang-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: pasang](https://img.shields.io/badge/Open%20VSX-pasang-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: unduh IDE](https://img.shields.io/badge/Releases-unduh%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: laporkan bug](https://img.shields.io/badge/Issues-laporkan%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · **Bahasa Indonesia** · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![Tonton demo 2 menit di facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalasi

```sh
code --install-extension facade.facadecode
```

Atau pasang **Facade Code** dari [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) atau [Open VSX](https://open-vsx.org/extension/facade/facadecode). Ekstensi ini dapat dijalankan di macOS (Apple silicon), Linux (x64), dan Windows (x64).

Selanjutnya, pasang dan masuk ke CLI agen yang didukung yang ingin Anda gunakan: Claude Code, Codex, Antigravity, Muse Code, OpenCode, atau Pi. Facade Code menjalankan setiap CLI menggunakan akun dan langganan miliknya sendiri.

> **Agen berjalan tanpa konfirmasi persetujuan secara default.** Dengan `facade.yolo` yang aktif secara default, agen dapat menjalankan perintah dan mengubah berkas tanpa meminta izin terlebih dahulu. Nonaktifkan pengaturan ini untuk memulihkan konfirmasi persetujuan standar setiap CLI. Lihat [README ekstensi](../../../extension/README.md#install).

## Agent Panel

**Agen dan IDE Anda, dalam jendela yang sama.**

Facade Code menjalankan CLI agen native (Claude Code, Codex, Antigravity, Muse Code, OpenCode, dan Pi) di tab terminal editor di samping berkas Anda, menggunakan perintah, alat, akun, dan langganan milik masing-masing CLI. Sebuah kartu di panel melacak status setiap agen.

- **Bekerja di samping kode Anda.** Setiap agen berjalan di tab terminalnya sendiri di area editor. Menutup tab hanya menyembunyikannya sementara agen tetap berjalan; mengeklik kartunya akan membukanya kembali.
- **Lacak status di seluruh agen.** Kartu menampilkan siapa yang memulai setiap agen, apa yang sedang dilakukannya, dan apakah agen siap menerima input, memerlukan izin, atau mengalami kesalahan. Agen tetap berjalan melalui muat ulang jendela dan mulai ulang ekstensi.
- **Folder dan worktree.** Jalankan agen di folder ruang kerja mana pun atau buat Git worktree secara instan untuk memisahkan perubahan kode. Sematkan percakapan untuk memulihkannya saat Anda membuka ruang kerja kembali, atau lanjutkan sesi sebelumnya dari riwayat.

## Agent Use

**Biarkan agen mengoperasikan agen lain, sama seperti Anda.**

Melalui MCP dan protokol terminal, agen dapat memulai, menghentikan, menemukan, dan mengirim pesan ke agen lain, membaca layar terminal mereka, mengetik teks, dan menekan tombol keyboard.

- **Mulai dan hentikan agen.** Agen dapat memulai agen lain dengan salah satu dari enam CLI, di folder mana pun atau worktree baru pada jendela Facade Anda di komputer ini, serta memberi mereka tugas pertama. Permintaan yang dicoba ulang dengan ID permintaan yang sama tidak akan pernah memulai agen kedua.
- **Kirim pesan.** Agen saling bertukar pesan satu sama lain dan dapat mengirim pesan kepada Anda. Facade menempelkan seluruh pesan sekaligus dan mengirimkannya. Jika ada teks yang belum terkirim atau pertanyaan prompt yang menghalangi, pengiriman akan menunggu hingga input bersih.
- **Kontrol terminal.** Agen dapat membaca layar agen lain, mengetik perintah, dan menekan tombol keyboard untuk menjawab prompt atau membantu rekan yang macet. Ketika agen turunan menunggu selama 20 detik untuk menerima input atau izin, agen yang memulainya akan diberi tahu.

## Agent Mesh

**Hubungkan agen lintas jendela, mesin, dan lokasi.**

Facade Code menghubungkan agen di seluruh jendela Facade Anda di komputer ini ke dalam satu jaringan. Buka jendela [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) untuk memperluas kolaborasi tersebut ke mesin lain.

- **Lintas jendela.** Dengan `facade.yolo` aktif, agen dapat menjangkau setiap agen di seluruh jendela Facade Anda di komputer ini, baik lokal maupun Remote - SSH. Dengan pengaturan tersebut nonaktif, agen hanya menjangkau grupnya sendiri: agen yang Anda mulai dan agen yang dimulai darinya.
- **Perluas melalui SSH.** Di jendela [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh), agen berjalan langsung di mesin jarak jauh dengan alat, berkas, dan akun di sana. Agen lokal dapat memulai dan mengirim pesan ke agen di jendela Remote - SSH secara langsung.
- **Koordinasikan dari ponsel Anda.** Hubungkan aplikasi seluler Claude ke sesi Claude Code di komputer Anda menggunakan [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). Sesi tersebut dapat mengoordinasikan agen lain melalui Facade dan melaporkan kemajuan kembali ke ponsel Anda.

<sub>Remote Control memerlukan versi Claude Code yang didukung, langganan yang memenuhi syarat, dan proses masuk dengan cakupan penuh. Lihat [persyaratan penyiapannya](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Banyak proyek. Satu jendela.**

Atur proyek, worktree fitur, dan tim agen dalam bilah ruang kerja khusus. Beralih antar proyek beserta berkas dan terminal yang relevan, sementara agen terus bekerja di latar belakang.

Unduh pratinjau IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Semua rilis](https://github.com/y5ez3g/facadecode/releases)

IDE ini adalah fork dari VS Code yang dipasang berdampingan dengan editor Anda yang sudah ada dan tidak berbagi apa pun dengannya: pengaturan, ekstensi, dan perintah `facade` sepenuhnya terpisah. Ekstensinya berasal dari [Open VSX](https://open-vsx.org); beberapa ekstensi berpemilik Microsoft, seperti Remote Development dan C/C++, hanya dapat berjalan di build resmi Microsoft. Arsitektur dan spesifikasi tersedia di [`docs/ide/`](../../ide/).

## Membangun dari Sumber

- **Ekstensi:** Berikan [`extension/AGENTS.md`](../../../extension/AGENTS.md) kepada agen coding Anda untuk membangun paket.
- **IDE:** Berikan [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) kepada agen coding Anda untuk membangun aplikasi.

Untuk panduan kontribusi dan aturan branch, lihat [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) dan [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Masukan

- **Bug & ide**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), atau **Help > Report Issue** di IDE.
- **Kerentanan keamanan**: Harap laporkan secara privat sesuai dengan [`SECURITY.md`](../../../SECURITY.md).

## Lisensi

MIT, sesuai dengan upstream VS Code. Lihat [`LICENSE.txt`](../../../LICENSE.txt) untuk pemberitahuan hak cipta Microsoft dan pemberitahuan kontributor Facade Code.

<sub>Facade Code adalah produk independen dan tidak berafiliasi dengan, didukung oleh, atau disponsori oleh penyedia alat pihak ketiga yang ditampilkan. Semua merek dagang dan logo pihak ketiga adalah milik pemiliknya masing-masing.</sub>
