<div align="center">

<img src="../../../extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**VS Code için çoklu aracı orkestratörü.**

Yerel aracı CLI'larını çalıştırın, kod düzenleyin ve değişiklikleri aynı IDE penceresinde inceleyin. Kendi hesaplarınızı ve aboneliklerinizi kullanın, aracıların pencereler ve makineler arasında iş birliği yapmasını sağlayın.

[![Web Sitesi: facadecode.com](https://img.shields.io/badge/Web%20Sitesi-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: yükle](https://img.shields.io/badge/VS%20Code%20Marketplace-y%C3%BCkle-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: yükle](https://img.shields.io/badge/Open%20VSX-y%C3%BCkle-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Sürümler: IDE'yi indir](https://img.shields.io/badge/S%C3%BCr%C3%BCmler-IDE'yi%20indir-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Sorunlar: hata bildir](https://img.shields.io/badge/Sorunlar-hata%20bildir-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

[English](../../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · **Türkçe** · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

[![facadecode.com adresinde 2 dakikalık demoyu izleyin](../../assets/readme/demo-poster.jpg)](https://facadecode.com)

## Kurulum

```sh
code --install-extension facade.facadecode
```

Veya **Facade Code**'u [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) ya da [Open VSX](https://open-vsx.org/extension/facade/facadecode) üzerinden yükleyin. macOS (Apple silicon), Linux (x64) ve Windows (x64) üzerinde çalışır.

Ardından, kullanmayı planladığınız desteklenen aracı CLI'larını yükleyin ve oturum açın: Claude Code, Codex, Antigravity, Muse Code, OpenCode veya Pi. Facade Code her CLI'yı kendi oturum açma bilgilerini ve aboneliklerini kullanarak başlatır.

> **Aracılar varsayılan olarak onay istemi olmadan çalışır.** `yolo` varsayılan olarak etkinken aracılar komutları çalıştırabilir ve dosyaları önceden sormadan değiştirebilir. Her CLI'nın standart onay istemlerini geri getirmek için bunu kapatın. [Uzantı README](../../../extension/README.md#install) dosyasına bakın.

## Agent Panel

**Aracılarınız ve IDE'niz aynı pencerede.**

Facade Code, yerel aracı CLI'larını (Claude Code, Codex, Antigravity, Muse Code, OpenCode ve Pi) dosyalarınızın yanında düzenleyici terminal sekmelerinde çalıştırır; her CLI'nın kendi komutlarını, araçlarını, hesaplarını ve aboneliklerini kullanır. Paneldeki bir kart her aracının durumunu izler.

- **Kodunuzun yanında çalışın.** Her aracı, düzenleyici alanında kendi terminal sekmesinde çalışır. Bir sekmeyi kapatmak, aracı çalışmaya devam ederken onu gizler; kartına tıklamak sekmeyi yeniden açar.
- **Aracıların durumunu takip edin.** Kartlar her aracıya son olarak ne gönderildiğini ve çalışıyor mu, izin mi bekliyor yoksa bir hatayla mı karşılaştı gösterir; ayrıntılar ise başlığını, klasörünü ve onu kimin başlattığını gösterir. Aracılar pencere yeniden yüklemeleri ve uzantı yeniden başlatmaları boyunca çalışmaya devam eder.
- **Klasörler ve çalışma ağaçları.** Aracıları herhangi bir çalışma alanı klasöründe çalıştırın veya kod değişikliklerini ayrı tutmak için anında bir Git çalışma ağacı (worktree) oluşturun. Çalışma alanını tekrar açtığınızda geri yüklemek için bir konuşmayı sabitleyin (Pin) veya geçmişten önceki oturumları devam ettirin.

## Agent Use

**Tıpkı sizin gibi, aracıların diğer aracıları yönetmesine izin verin.**

MCP ve bir terminal protokolü aracılığıyla aracılar diğer aracıları başlatabilir, durdurabilir, bulabilir, onlara mesaj gönderebilir, terminal ekranlarını okuyabilir, metin yazabilir ve tuşlara basabilir.

- **Aracıları başlatın ve durdurun.** Bir aracı, bu bilgisayardaki Facade pencerelerinizin herhangi bir klasöründe veya yeni çalışma ağacında altı CLI'dan herhangi biriyle başka aracılar başlatabilir ve onlara ilk görevlerini verebilir. Aynı istek kimliğiyle (request ID) yinelenen bir istek asla ikinci bir aracı başlatmaz.
- **Mesaj gönderin.** Aracılar birbiriyle mesajlaşır ve size mesaj gönderebilir. Facade tüm mesajı tek seferde yapıştırır ve gönderir. Gönderilmemiş bir metin veya bir komut istemi sorusu aradaysa, teslimat girdi alanı temizlenene kadar bekler.
- **Terminal kontrolü.** Bir aracı, istemleri yanıtlamak veya takılan bir çalışma arkadaşına yardımcı olmak için başka bir aracının ekranını okuyabilir, komutlar yazabilir ve tuşlara basabilir. Bir alt aracı izin, yanıt veya oturum açma için 20 saniye beklediğinde, onu başlatan aracıya bildirim gönderilir.

## Agent Mesh

**Aracıları pencereler, makineler ve konumlar arasında bağlayın.**

Facade Code, bu bilgisayardaki Facade pencerelerinizdeki aracıları tek bir ağda birleştirir. Bu iş birliğini başka bir makineye genişletmek için bir [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) penceresi açın.

- **Pencereler arasında.** `yolo` açıkken bir aracı, bu bilgisayardaki Facade pencerelerinizdeki yerel ve Remote - SSH dahil tüm aracılara ulaşır. Kapalıyken yalnızca kendi grubuna ulaşır: başlattığınız aracı ve ondan başlatılanlar.
- **SSH üzerinden genişletin.** Bir [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) penceresinde aracılar doğrudan uzak makinede oradaki araçlar, dosyalar ve hesaplarla çalışır. Yerel aracılar, Remote - SSH pencerelerindeki aracıları doğrudan başlatabilir ve onlara mesaj gönderebilir.
- **Telefonunuzdan koordine edin.** [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) kullanarak Claude mobil uygulamasını bilgisayarınızdaki bir Claude Code oturumuna bağlayın. Bu oturum diğer aracıları Facade üzerinden koordine edebilir ve ilerlemeyi telefonunuza bildirebilir.

<sub>Remote Control desteklenen bir Claude Code sürümü, uygun bir abonelik ve tam kapsamlı oturum açma gerektirir. [Kurulum gereksinimlerine](https://code.claude.com/docs/en/remote-control#requirements) bakın.</sub>

## Facade Code IDE (Preview)

**Birden çok proje. Tek pencere.**

Projeleri, özellik çalışma ağaçlarını ve aracı ekiplerini özel bir çalışma alanı çubuğunda düzenleyin. Aracılar arka planda çalışmaya devam ederken ilgili dosyaları ve terminalleriyle projeler arasında geçiş yapın.

IDE önizlemesini indirin: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [Tüm sürümler](https://github.com/y5ez3g/facadecode/releases)

IDE, mevcut düzenleyicinizin yanına yüklenen ve onunla hiçbir şey paylaşmayan bir VS Code çatalıdır (fork): ayarlar, uzantılar ve `facade` komutu tamamen ayrıdır. Uzantıları [Open VSX](https://open-vsx.org) üzerinden gelir; Remote Development ve C/C++ gibi birkaç tescilli Microsoft uzantısı yalnızca resmi Microsoft derlemelerinde çalışır. Mimari ve spesifikasyonlar [`docs/ide/`](../../ide/) altındadır.

## Kaynaktan Derleme

- **Uzantı:** Paketi derlemesi için kodlama aracınıza [`extension/AGENTS.md`](../../../extension/AGENTS.md) dosyasını verin.
- **IDE:** Uygulamayı derlemesi için kodlama aracınıza [`docs/ide/RELEASE.md`](../../ide/RELEASE.md) dosyasını verin.

Katkıda bulunma yönergeleri ve dal disiplini için [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) ve [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md) dosyalarına bakın.

## Geri Bildirim

- **Hatalar ve fikirler:** [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) veya IDE içinde **Yardım > Sorun Bildir**.
- **Güvenlik açıkları:** Lütfen [`SECURITY.md`](../../../SECURITY.md) dosyasına göre gizli olarak bildirin.

## Lisans

Yukarı akış VS Code ile eşleşen MIT. Microsoft'un telif hakkı bildirimi ve Facade Code katkıda bulunanların bildirimleri için [`LICENSE.txt`](../../../LICENSE.txt) dosyasına bakın.

<sub>Facade Code bağımsız bir üründür ve gösterilen üçüncü taraf araçların sağlayıcılarına bağlı değildir, onlar tarafından onaylanmamıştır veya desteklenmemektedir. Tüm üçüncü taraf ticari markaları ve logoları ilgili sahiplerine aittir.</sub>
