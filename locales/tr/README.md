<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Sizin ve yapay zekâ ekibiniz için tek bir IDE.**

VS Code üzerine kurulu. Claude Code, Codex, Antigravity, Muse Code ve Qwen Code gibi yerel ajan CLI'larınızı doğrudan çalıştırır.

[İndir](https://github.com/y5ez3g/facadecode/releases) ·
[Spesifikasyonlar](../../facade-code-spec/) ·
[Hata Bildir](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · **Türkçe** · [Tiếng Việt](../vi/README.md) · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code, VS Code'un bir fork'udur. Her sağlayıcının yerel ajanları projeleriniz ve özellikleriniz üzerinde birlikte çalışır; siz de aynı pencerede kodu inceler ve istediğiniz ajanı yönlendirirsiniz.

- 🧑‍💻 **Projelere ve özelliklere göre düzenlenmiş eksiksiz VS Code.** Tek pencerede birden çok proje ve özellik geliştirin. Her özellik bir git worktree'dir ve kendine ait bir ajan ekibi vardır.
- 🤖 **Farklı sağlayıcılardan yerel ajan CLI'larından oluşan bir ekip.** Ajanlar mevcut aboneliklerinizle çalışır. Facade Code'da ajanlar birbirini başlatır, birbirine mesaj gönderir ve takılan birine yardım eder.
- 👥 **Super Engineer ya da Super Team.** Birden çok ajanı kendiniz yönetin ya da uzmanları paralel olarak koordine edecek bir lider model belirleyin.

## Kurulum

En son sürümü [Releases](https://github.com/y5ez3g/facadecode/releases) sayfasından indirin: macOS (Apple silicon) için `.dmg`, Windows (x64) için bir yükleyici veya Ubuntu (x64) için `.deb`.

**Ön koşullar**: Kullanmak istediğiniz ajan CLI'larını kurun ve oturum açın (Claude Code, Codex, Antigravity, Muse Code veya Qwen Code'un herhangi bir birleşimi). Facade Code bunları kendi yerel kimlik doğrulamaları ve abonelikleriyle doğrudan çalıştırır.

Facade Code, VS Code'un yanına kurulur ve onunla hiçbir şey paylaşmaz: ayarlar, eklentiler ve `facade` komut satırı aracı tamamen ayrıdır.

## Hızlı Başlangıç

1. **Bir proje açın**:
   ```sh
   facade ~/code/space-shooter
   ```
   Ya da **File > Open Folder** (Dosya > Klasör Aç) kullanın veya bir klasörü çalışma alanı çubuğuna sürükleyip bırakın. Klasörün bir git deposu olması gerekir (worktree'ler git gerektirir; sıfırdan başlıyorsanız önce `git init` çalıştırın).

2. **Bir teknik lider başlatın**:
   Başlık çubuğundaki robot simgesine (Agent menüsü) tıklayın ya da Komut Paleti'nde **Agents: Start Agent...** (ajan başlat) komutunu çalıştırın ve Claude Code veya Codex'i seçin. Facade Code içinden başlatılan ajan, Facade'ın MCP araçlarıyla donatılır.

3. **Ona teknik lider prompt'unu verin**:
   ```text
   Sen teknik lidersin. Facade'ı kullanarak bir demo için tarayıcıda (masaüstü) çalışan
   neon bir uzay nişancı oyunu yap. Ekipte Codex üzerinden GPT Sol 6 (gpt-6-sol, max)
   kullanan, görünüm ve oyun hissinden sorumlu bir PD ile paralel çalışan üç Muse 1.3
   mühendisi (muse-spark-1.3, max) olsun. Küçük tut, yaklaşık yarım saatlik bir iş:
   bir bölüm, üç düşman türü, iki aşamalı bir boss, güçlendirmeler, skor ve kombolar.
   Daha fazla özellik eklemektense oyunu bitirip iyice cilalamak daha iyi. Mühendisler kendi işlerini kendileri
   birleştirsin, sen sonra incele. Bana kısa bir plan, bir kulvar diyagramı ve PD'nin
   maketini içeren tek bir HTML sayfası gönder ve başlamadan önce onayımı bekle.
   ```

4. **Ekibin birlikte çalışmasını izleyin**:
   Başlatılan PD ve mühendisler, çalışma alanı çubuğunda kendi proje ve özelliklerinin altında görünür. HTML planı onayladığınızda geliştirmeye başlarlar. İstediğiniz zaman herhangi bir ajanın terminaline tıklayıp çıktısına bakabilir ya da onunla doğrudan konuşabilirsiniz.

*(Not: Bu örnek prompt, 5 ajanı en yüksek akıl yürütme düzeyinde başlatır. CLI'ları, modelleri, akıl yürütme düzeylerini ve mühendis sayısını sahip olduğunuz aboneliklere göre ayarlayın.)*

## Özellikler

### Oturumlar değil, projeler ve özellikler

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Çoğu ajan aracı her ajan oturumu için bir worktree oluşturur. Facade Code bunun tersini yapar: her worktree bir özelliktir, kendi deposunun altında listelenir ve ona ajanları siz atarsınız.

Bir özellik çoğu zaman birden fazla ajana ihtiyaç duyar. Kodu yazan ajan, yaptığı işi iyi anlatamayabilir ya da tasarım konusunda iyi bir gözü olmayabilir; bu yüzden diğer ajanlar belgeleme, tasarım ve incelemede yardım eder, hepsi aynı worktree'de. Ajanlar gelir gider; özellik kalır.

- **Çalışma alanı çubuğu**: Tüm depoları ve özellikleri tek bir sütunda listeler. Birine tıkladığınızda tüm pencere (gezgin, düzenleyiciler, terminaller ve kaynak denetimi) değişir ve bıraktığınız gibi geri yüklenir. Projeler asla birbirine karışmaz. Bkz. [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Worktree yaşam döngüsü**: **New Worktree** (yeni worktree) dalı oluşturur, `.worktreeinclude` içinde listelenen yerel dosyaları eşitler ve kurulumu çalıştırır. **Delete Worktree** (worktree'yi sil), kaldırmadan önce nelerin kaybolacağını ayrıntılı olarak gösterir. Bkz. [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Paralel alt görevler**: Birbirinden bağımsız görevler ayrı worktree'lere ayrılabilir.

### Her sağlayıcıdan bir ekip

- **Kendi aboneliklerinizle yerel CLI'lar**: Claude Code, Codex, Muse Code, Antigravity ve Qwen Code, mevcut aboneliklerinizi kullanarak kendi tümleşik terminallerinde çalışır.
- **Ajanlar ajan başlatır**: Bir ajan, mevcut özellikte ya da yeni bir worktree'de başka ajanlar (herhangi bir sağlayıcının CLI'ı veya modeliyle) başlatabilir ve onlara görev atayabilir. Bkz. [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) ve [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Mesajlaşma**: Ajanlar birbirine mesaj gönderir, sonuçları kendilerini çağırana bildirir ve bir karar insan onayı gerektirdiğinde size haber verir. Bkz. [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Takılan ajanlara yardım**: Bir ajan, başka bir ajanın terminalini okuyabilir, istemlerini yanıtlayabilir ve tuş vuruşları göndererek takılan bir çalışana sizi rahatsız etmeden yardım edebilir. Bkz. [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Her birine müdahale edebilirsiniz**: Her ajanın, kendi özelliğinin altında kendine ait bir terminal satırı vardır. Ne yaptığını görürsünüz ve istediğiniz an doğrudan içine yazabilirsiniz.
- **Standart MCP**: Tüm orkestrasyon araçları standart bir MCP sunucusu üzerinden sunulur.

## İki Çalışma Biçimi

Darboğaz, geliştiricinin dikkatidir. İki mod, iki farklı yetki devri düzeyini temsil eder:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Rolünüz** | Kodu bizzat yazan mühendis | Mühendislik yöneticisi |
| **Muhatabınız** | Doğrudan birden çok ajan | Bir teknik lider ajan, birebir |
| **Ajanları kim koordine eder** | Siz | Teknik lider |
| **En uygun olduğu durumlar** | Yakından yönlendirme isteyen özellikler: keşif niteliğindeki işler, kendiniz değerlendirmek istediğiniz tasarım kararları, değişen gereksinimler | Temiz bir şekilde bölünebilen, büyük ve iyi tanımlanmış özellikler |

İkisini aynı pencerede birlikte kullanabilirsiniz: hassas özellikleri yakından kontrol ederken kapsamı net işleri bir lidere devredin.

- **Super Engineer**: Worktree'leri siz açar, depolar arasında ajanlara görev atar ve her biri bitirdikçe kodu incelersiniz.
- **Super Team**: Bir özelliği, teknik lider olarak bir ajana teslim edersiniz. Lider görevleri böler, arayüz sözleşmelerini belirler, çalışanları başlatır ve çıktılarını inceler.
  - Güçlü bir model liderlik eder; daha hızlı ve daha ucuz modeller mevcut aboneliklerinizle paralel olarak uygular; farklı sağlayıcıların modelleri de birbirinin işini inceler.
  - Kurmak için bir prompt yeterlidir (bkz. [Hızlı Başlangıç](#hızlı-başlangıç)); tekrar tekrar kullandığınız ekip iş akışları skill olarak yazılabilir.

*(Bu README de aynı şekilde yazıldı: bir ajan analiz etti, bir ajan taslağı yazdı ve son kararı bir insan verdi.)*

## Neden

Çoğu yapay zekâ kodlama aracı iki kampa ayrılır: insanın satır satır takip etmesi gereken Copilot tarzı IDE'ler ve kod incelemesi ile hata ayıklamanın harici bir düzenleyiciye bırakıldığı ajan IDE'leri. Hiçbiri, farklı sağlayıcılardan yerel ajanlardan oluşan bir ekibi ana IDE'nizin içinde bir araya getirmez.

Geleceğin, bir ajan ekibiyle birden çok proje ve özelliği yürüten tek bir geliştirici olduğuna inanıyoruz. Farklı modeller farklı işlerde öne çıkar; bu yüzden ekip birden çok sağlayıcıyı kapsamalıdır. Ve incelediğiniz kodu ajanlar yazdığına göre, o ekibin yeri sizin IDE'nizdir.

## Hâlâ VS Code

Facade Code yalnızca çoklu proje ve ajan yönetiminin gerektirdiği yerleri değiştirir:

- **Çalışma alanı çubuğu** ilk sütunu kaplar; **etkinlik çubuğu** başlık çubuğunun sağ üstüne taşınır (`workbench.activityBar.location` ile geri alınabilir).
- Upstream'deki Copilot ve sohbet varsayılan olarak kapalıdır (tek bir ayarla yeniden açılabilir).
- Geri kalan her şey standart VS Code'dur: düzenleyici, ayarlar, tuş atamaları, `.vscode/` ve `.code-workspace` dosyaları.
- Eklentiler [Open VSX](https://open-vsx.org) üzerinden kurulur. Remote Development ve C/C++ gibi bazı tescilli Microsoft eklentileri yalnızca resmî Microsoft derlemeleri için lisanslıdır ve fork'larda çalışamaz.

## Kaynaktan Derleme

[`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) dosyasını ajanınıza verin, derlemeyi o yapsın.

Katkı yönergeleri ve dal kuralları için [`CONTRIBUTING.md`](CONTRIBUTING.md) ve [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md) dosyalarına bakın.

## Geri Bildirim

- **Hatalar ve fikirler**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) ya da düzenleyicideki **Help > Report Issue** (Yardım > Sorun Bildir).
- **Güvenlik açıkları**: Lütfen [`SECURITY.md`](SECURITY.md) dosyasındaki yönergelere göre gizli olarak bildirin.

## Lisans

MIT, upstream VS Code ile aynı. Microsoft'un telif hakkı bildirimi ve Facade Code katkıcılarının bildirimleri için [`LICENSE.txt`](../../LICENSE.txt) dosyasına bakın.
