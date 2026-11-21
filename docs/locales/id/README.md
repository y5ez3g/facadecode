<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Jalankan agen pemrograman AI di mesin Anda sendiri.**

Facade Code menjalankan sejumlah CLI pemrograman AI di mesin Anda. Agen dapat saling menemukan, bertukar pesan, membaca layar, dan mengetik di terminal. Anda dapat mengarahkan mereka dari Shell, VS Code, atau aplikasi yang mendukung MCP. Setiap mesin menjalankan Orchestrator sendiri dan terhubung melalui SSH.

[![Situs web: facadecode.com](https://img.shields.io/badge/Situs%20web-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: pasang](https://img.shields.io/badge/VS%20Code%20Marketplace-pasang-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: pasang](https://img.shields.io/badge/Open%20VSX-pasang-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: laporkan bug](https://img.shields.io/badge/Issues-laporkan%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · **Bahasa Indonesia** · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Tonton demo 2 menit di facadecode.com](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Instalasi

### Shell

Penginstal satu baris tersedia mulai rilis pertama yang menyertakan paket mandiri.
Paket Shell tersedia untuk macOS, Linux, dan Windows pada x64 serta arm64.

Jalankan perintah ini di macOS atau Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://github.com/y5ez3g/facadecode/releases/latest/download/install.sh
```

Di Windows, jalankan perintah ini di PowerShell.

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'https://github.com/y5ez3g/facadecode/releases/latest/download/install.ps1'; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())))
```

Penginstal menambahkan `facade` dan `facade-mcp` ke PATH. Buka terminal baru untuk menggunakan PATH yang diperbarui. Jalankan `facade upgrade` untuk memperbarui. Instal CLI yang dibutuhkan dan masuk di setiap mesin. Pilihan bawaan mencakup Claude Code, Codex, Antigravity, Muse Code, OpenCode, dan Pi.

Peluncurnya juga bernama `facade`. Jika keduanya terpasang, Shell memakai entri pertama di PATH. Setelah pratinjau dihentikan, nama itu menjadi milik Orchestrator. Jalankan `facade --version`. Baris berbentuk `facade <version>` mengonfirmasi bahwa perintah Shell yang digunakan.

### VS Code

```sh
code --install-extension facade.facadecode
```

Ekstensi menyertakan Orchestrator. Buka **Facade Code** di bilah aktivitas, lalu pilih **New Agent**, **Go to Agent**, atau **Resume Agent**. Paket macOS, Linux, dan Windows dibuat untuk x64 dan arm64.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [VS Code](../../../extension/GUIDE.md)

### MCP

Tambahkan `facade-mcp` sebagai server MCP stdio. Contoh ini memakai objek `mcpServers`.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

Koneksi eksternal bergabung sebagai Guest saat pertama kali memanggil alat. Setelah mengirim pesan, tunggu jawaban dengan panggilan `read_messages` yang dikembalikan `send_message`.

## Bekerja di beberapa mesin

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Gunakan alamat dari `facade list`. Daftarkan mesin lain memakai target dan opsi SSH yang biasa Anda pakai. Untuk menjangkau WSL atau Dev Container dari luar, siapkan SSH di lingkungan itu dan daftarkan dengan cara yang sama. Anda juga dapat menjalankan Facade langsung di dalamnya.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade memasang versi yang sesuai pada mesin jarak jauh bila diperlukan. Facade memakai jalur instalasi tetap di mesin jarak jauh. Jika memasang secara manual, gunakan versi yang sama dengan Orchestrator lokal. Di VS Code, **Go to Agent** membuka terminal agen yang sedang berjalan. Ruang kerja mengingat agen yang dibuka, para pembantunya, dan Pin Anda. Menutup tab terminal membiarkan agen berjalan. **Resume Agent** dan `facade resume` menawarkan pekerjaan yang tersimpan.

> **YOLO aktif secara default.** Agen dengan YOLO dapat menjangkau agen di mesin yang terhubung. Tetapkan `"yolo": false` di `facade.json` mesin itu untuk mempertahankan persetujuan dan sandbox CLI serta membatasi MCP ke pohon pembuatan pemanggil. Pengaturan berlaku pada start atau resume berikutnya. `facade status` menampilkan lokasi file.

[Dokumentasi produk (bahasa Inggris)](../../PRODUCT.md) · [Glosarium](../../core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Banyak proyek. Satu jendela.**

Atur proyek, worktree fitur, dan tim agen dalam bilah ruang kerja khusus. Beralih antar proyek beserta berkas dan terminal yang relevan, sementara agen terus bekerja di latar belakang.

Unduh pratinjau IDE: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Semua rilis](https://github.com/y5ez3g/facadecode/releases)

Pratinjau IDE dipasang berdampingan dengan editor Anda dan menggunakan pengaturan serta ekstensi sendiri. Ekstensinya berasal dari [Open VSX](https://open-vsx.org); beberapa ekstensi berpemilik Microsoft, seperti Remote Development dan C/C++, hanya dapat berjalan di build resmi Microsoft. Arsitektur dan spesifikasi tersedia di [`docs/ide/`](../../ide/).

## Membangun dari Sumber

- **Ekstensi:** Berikan [`extension/AGENTS.md`](../../../extension/AGENTS.md) kepada agen coding Anda untuk membangun paket.
- **Orchestrator / Shell.** [Petunjuk build](../../../core/README.md).
- **IDE:** Berikan [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) kepada agen coding Anda untuk membangun aplikasi.

Untuk panduan kontribusi dan aturan branch, lihat [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) dan [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md).

## Masukan

- **Bug & ide**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), atau **Help > Report Issue** di IDE.
- **Kerentanan keamanan**: Harap laporkan secara privat sesuai dengan [`SECURITY.md`](../../../SECURITY.md).

## Lisensi

MIT, sesuai dengan upstream VS Code. Lihat [`LICENSE.txt`](../../../LICENSE.txt) untuk pemberitahuan hak cipta Microsoft dan pemberitahuan kontributor Facade Code.

<sub>Facade Code adalah produk independen dan tidak berafiliasi dengan, didukung oleh, atau disponsori oleh penyedia alat pihak ketiga yang ditampilkan. Semua merek dagang dan logo pihak ketiga adalah milik pemiliknya masing-masing.</sub>
