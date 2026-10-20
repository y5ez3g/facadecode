<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Satu IDE untuk Anda dan tim AI Anda.**

Dibangun di atas VS Code. Menjalankan CLI agen native Anda, seperti Claude Code, Codex, Antigravity, dan Muse Code.

[Unduh](https://github.com/y5ez3g/facadecode/releases) ·
[Spesifikasi](../../facade-code-spec/) ·
[Laporkan Bug](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · **Bahasa Indonesia** · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code adalah fork VS Code tempat agen native dari semua vendor berkolaborasi di proyek dan fitur Anda, sementara Anda meninjau kode dan mengarahkan agen mana pun di jendela yang sama.

- 🧑‍💻 **VS Code lengkap, ditata per proyek dan fitur.** Kembangkan banyak proyek dan fitur dalam satu jendela. Setiap fitur adalah sebuah git worktree, dengan tim agen khusus.
- 🤖 **Tim CLI agen native lintas vendor.** Agen berjalan dengan langganan yang sudah Anda miliki. Di Facade Code, agen dapat menjalankan agen lain, saling berkirim pesan, dan saling membantu saat ada yang macet.
- 👥 **Super Engineer atau Super Team.** Arahkan sendiri banyak agen, atau tunjuk satu model pemimpin untuk mengoordinasikan para spesialis secara paralel.

## Instalasi

Unduh rilis terbaru dari [Releases](https://github.com/y5ez3g/facadecode/releases): `.dmg` untuk macOS (Apple silicon), installer untuk Windows (x64), atau `.deb` untuk Ubuntu (x64).

**Prasyarat**: Instal dan login ke CLI agen yang ingin Anda gunakan (kombinasi apa pun dari Claude Code, Codex, Antigravity, atau Muse Code). Facade Code menjalankannya secara langsung dengan autentikasi dan langganan native masing-masing.

Facade Code terpasang berdampingan dengan VS Code dan tidak berbagi apa pun dengannya: pengaturan, ekstensi, dan alat baris perintah `facade` sepenuhnya terpisah.

## Mulai Cepat

1. **Buka sebuah proyek**:
   ```sh
   facade ~/code/space-shooter
   ```
   Atau gunakan **File > Open Folder** (Berkas > Buka Folder), atau seret folder ke bilah workspace. Folder tersebut harus berupa repositori git (worktree memerlukan git; jalankan `git init` terlebih dahulu jika memulai dari nol).

2. **Jalankan seorang tech lead**:
   Klik ikon robot di bilah judul (menu Agent), atau jalankan **Agents: Start Agent...** (jalankan agen) di Command Palette, lalu pilih Claude Code atau Codex. Agen yang dijalankan dari dalam Facade Code dibekali alat MCP milik Facade.

3. **Berikan prompt untuk tech lead kepadanya**:
   ```text
   Kamu adalah tech lead. Gunakan Facade untuk membuat game tembak-tembakan luar angkasa
   bergaya neon untuk browser (desktop) sebagai demo, dengan seorang PD di GPT Sol 6
   (gpt-6-sol, max) lewat Codex yang bertanggung jawab atas tampilan dan nuansa game,
   serta tiga engineer Muse 1.3 (muse-spark-1.3, max) yang bekerja paralel. Buat tetap
   kecil, kira-kira setengah jam pengerjaan: satu level, tiga jenis musuh, bos dua fase,
   power-up, skor, dan kombo. Lebih baik game kecil yang selesai dan dipoles daripada
   banyak fitur. Para engineer me-merge pekerjaan mereka sendiri dan kamu meninjaunya
   setelahnya. Kirimi aku satu halaman HTML berisi rencana singkat, diagram swimlane, dan mockup dari PD, lalu
   tunggu persetujuanku sebelum mulai.
   ```

4. **Saksikan tim berkolaborasi**:
   PD dan para engineer yang dijalankan muncul di bilah workspace, di bawah proyek dan fitur mereka. Begitu Anda menyetujui rencana HTML tersebut, mereka mulai membangun. Anda bisa masuk ke terminal agen mana pun kapan saja untuk melihat output atau berbicara langsung dengannya.

*(Catatan: Contoh prompt ini menjalankan 5 agen pada tingkat penalaran maksimum. Sesuaikan CLI, model, tingkat penalaran, dan jumlah engineer dengan langganan yang Anda miliki.)*

## Fitur

### Proyek dan fitur, bukan sesi

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Kebanyakan alat agen membuat satu worktree untuk setiap sesi agen. Facade Code justru sebaliknya: setiap worktree adalah sebuah fitur, tercantum di bawah repositorinya, dan Anda yang menugaskan agen ke sana.

Sebuah fitur sering membutuhkan lebih dari satu agen. Agen yang menulis kode belum tentu bisa menjelaskan pekerjaannya dengan jelas atau punya selera desain yang baik, jadi agen lain membantu dengan dokumentasi, desain, dan review, semuanya di worktree yang sama. Agen datang dan pergi; fiturnya tetap ada.

- **Bilah workspace**: Menampilkan setiap repositori dan fitur dalam satu kolom. Klik salah satunya untuk mengganti seluruh jendela (explorer, editor, terminal, dan source control), dipulihkan seperti saat Anda meninggalkannya. Proyek tidak pernah tercampur. Lihat [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Siklus hidup worktree**: **New Worktree** (worktree baru) membuat branch, menyinkronkan file lokal yang tercantum di `.worktreeinclude`, dan menjalankan setup. **Delete Worktree** (hapus worktree) merinci apa saja yang akan hilang sebelum menghapus. Lihat [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Subtugas paralel**: Tugas-tugas yang independen bisa dipecah ke worktree terpisah.

### Tim dari semua vendor

- **CLI native dengan langganan Anda sendiri**: Claude Code, Codex, Muse Code, dan Antigravity berjalan di terminal terintegrasi masing-masing, memakai langganan yang sudah Anda miliki.
- **Agen menjalankan agen**: Sebuah agen dapat menjalankan agen lain (dengan CLI atau model dari vendor mana pun) di fitur saat ini atau di worktree baru, lalu memberikan tugas. Lihat [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) dan [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Pesan**: Agen saling berkirim pesan, melaporkan hasil kepada pemanggilnya, dan memberi tahu Anda ketika sebuah keputusan memerlukan persetujuan manusia. Lihat [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Saling membantu saat macet**: Agen dapat membaca terminal agen lain, menjawab prompt, dan mengirim input keyboard untuk membantu agen lain yang macet tanpa mengganggu Anda. Lihat [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Anda bisa turun tangan di setiap agen**: Setiap agen punya baris terminalnya sendiri di bawah fiturnya. Anda melihat apa yang sedang dikerjakannya dan bisa mengetik langsung di dalamnya kapan saja.
- **MCP standar**: Semua alat orkestrasi disediakan melalui server MCP standar.

## Dua Cara Bekerja

Perhatian developer adalah hambatan utamanya. Kedua mode ini mewakili dua tingkat pendelegasian:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Peran Anda** | Engineer yang turun langsung | Engineering manager |
| **Dengan siapa Anda berinteraksi** | Langsung dengan banyak agen | Dengan satu agen tech lead, 1:1 |
| **Siapa yang mengoordinasikan agen** | Anda | Tech lead |
| **Paling cocok untuk** | Fitur yang butuh arahan dekat: pekerjaan eksploratif, keputusan desain yang ingin Anda nilai sendiri, kebutuhan yang terus berubah | Fitur besar yang terdefinisi jelas dan bisa dipecah dengan rapi |

Anda bisa memadukan keduanya di jendela yang sama: mengawasi langsung fitur yang sensitif sambil mendelegasikan pekerjaan yang lingkupnya jelas kepada seorang pemimpin.

- **Super Engineer**: Anda membuka worktree, memberikan tugas kepada agen di berbagai repositori, dan meninjau kode setiap kali satu agen selesai.
- **Super Team**: Anda menyerahkan sebuah fitur kepada satu agen sebagai tech lead. Ia memecah tugas, menetapkan kontrak antarmuka, menjalankan para pekerja, dan meninjau hasil kerja mereka.
  - Model yang kuat memimpin; model yang lebih cepat dan lebih murah, dengan langganan yang sudah Anda miliki, mengimplementasikan secara paralel; dan model dari vendor berbeda saling meninjau pekerjaan.
  - Satu prompt sudah cukup untuk menyiapkannya (lihat [Mulai Cepat](#mulai-cepat)); alur kerja tim yang Anda pakai berulang kali bisa ditulis sebagai skill.

*(README ini ditulis dengan cara yang sama: satu agen menganalisis, satu agen menyusun draf, dan seorang manusia membuat keputusan akhir.)*

## Mengapa

Kebanyakan alat coding AI terbagi dalam dua kubu: IDE bergaya Copilot, tempat manusia harus mengikuti baris demi baris, dan IDE agen, tempat review kode dan debugging diserahkan ke editor eksternal. Tidak satu pun yang menyatukan tim agen native lintas vendor di dalam IDE utama Anda.

Kami percaya masa depan adalah satu developer yang menjalankan banyak proyek dan fitur bersama sebuah tim agen. Model yang berbeda unggul di tugas yang berbeda, jadi tim itu sebaiknya lintas vendor. Dan karena agenlah yang menulis kode yang Anda tinjau, tim itu seharusnya berada di dalam IDE Anda.

## Tetap VS Code

Facade Code hanya mengubah apa yang dibutuhkan untuk mengelola banyak proyek dan agen:

- **Bilah workspace** menempati kolom pertama; **bilah aktivitas** pindah ke kanan atas bilah judul (bisa dikembalikan dengan `workbench.activityBar.location`).
- Copilot dan chat dari upstream dinonaktifkan secara default (satu pengaturan dapat mengaktifkannya kembali).
- Selebihnya adalah VS Code standar: editor, pengaturan, keybinding, `.vscode/`, dan file `.code-workspace`.
- Ekstensi dipasang dari [Open VSX](https://open-vsx.org). Beberapa ekstensi proprietary Microsoft, seperti Remote Development dan C/C++, hanya dilisensikan untuk build resmi Microsoft dan tidak bisa berjalan di fork.

## Membangun dari Kode Sumber

Serahkan [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) kepada agen Anda, dan biarkan ia yang membangun.

Untuk panduan kontribusi dan aturan branch, lihat [`CONTRIBUTING.md`](CONTRIBUTING.md) dan [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Masukan

- **Bug dan ide**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) atau **Help > Report Issue** (Bantuan > Laporkan Masalah) di editor.
- **Kerentanan keamanan**: Mohon laporkan secara privat sesuai [`SECURITY.md`](SECURITY.md).

## Lisensi

MIT, sama seperti VS Code upstream. Lihat [`LICENSE.txt`](../../LICENSE.txt) untuk pemberitahuan hak cipta Microsoft dan pemberitahuan para kontributor Facade Code.
