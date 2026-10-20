# Facade Code'a Katkıda Bulunmak

Yardımınız için teşekkürler. Facade Code, [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode) üzerinde açık olarak geliştirilir.

## Hatalar ve fikirler

Bir [issue](https://github.com/y5ez3g/facadecode/issues) açın; Help > Report Issue (Yardım > Sorun Bildir) sürümünüzü doldurulmuş olarak yeni bir issue açar. Lütfen önce mevcut issue'larda arama yapın ve bir hata için şunları belirtin:

- ne yaptığınızı, ne beklediğinizi ve bunun yerine ne olduğunu;
- Help > About (Yardım > Hakkında) bölümündeki sürümü ve işletim sisteminizi;
- bir ajan sorunuysa hangi ajan CLI'ını ve hangi sürümünü kullandığınızı.

Güvenlik açıkları issue'larda bildirilmez; bkz. [`SECURITY.md`](SECURITY.md).

## Kod

Bu deponun nasıl işlediği [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md) dosyasında anlatılır: derleme ortamının nasıl kurulacağı, bir değişikliği denetleyen komutlar ve aşağıdaki kuralların tamamı.

- `main` dalından `feature/<name>` adıyla dal açın.
- Merge edin, asla rebase etmeyin: bir özellik, incelemeden sonra `--no-ff` ile `main` dalına girer.
- Facade Code'un dosyalarını bir arada tutun; VS Code'un dosyalarında ise mantığı yeniden yazmak yerine isteğe bağlı kancalar (hook) ekleyin. Böylece daha yeni bir VS Code sürümünü birleştirmek az çaba gerektirir.
- Her özelliğin bir açma/kapama anahtarı vardır ve kapalıyken standart VS Code elde edilir.
- Her değişikliğe test ekleyin.
- Belgeleri, yorumları ve commit mesajlarını İngilizce yazın.

Bir özelliğin ne yapması gerektiği [`facade-code-spec/`](../../facade-code-spec/) içinde yazar. Davranışı değiştirmek için spesifikasyondan başlayın ya da önce bir issue açıp tartışın.

## Lisans

Katkıda bulunarak katkılarınızın projenin [MIT lisansı](../../LICENSE.txt) altında lisanslanmasını kabul etmiş olursunuz.
