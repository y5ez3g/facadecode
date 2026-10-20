<div align="center">

<img src="../../resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**Một IDE cho bạn và đội AI của bạn.**

Xây dựng trên VS Code. Chạy trực tiếp các CLI agent chính hãng của bạn, như Claude Code, Codex, Antigravity, Muse Code và Qwen Code.

[Tải về](https://github.com/y5ez3g/facadecode/releases) ·
[Đặc tả](../../facade-code-spec/) ·
[Báo lỗi](https://github.com/y5ez3g/facadecode/issues)

[English](../../README.md) · [简体中文](../zh-CN/README.md) · [繁體中文](../zh-TW/README.md) · [Português (Brasil)](../pt-BR/README.md) · [Español](../es/README.md) · [Русский](../ru/README.md) · [Deutsch](../de/README.md) · [日本語](../ja/README.md) · [Bahasa Indonesia](../id/README.md) · [Français](../fr/README.md) · [한국어](../ko/README.md) · [Türkçe](../tr/README.md) · **Tiếng Việt** · [Polski](../pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code là một bản fork của VS Code, nơi các agent chính hãng của mọi nhà cung cấp cùng làm việc trên các dự án và tính năng của bạn, còn bạn review code và chỉ đạo bất kỳ agent nào ngay trong cùng một cửa sổ.

- 🧑‍💻 **VS Code đầy đủ, tổ chức theo dự án và tính năng.** Phát triển nhiều dự án và tính năng trong một cửa sổ. Mỗi tính năng là một git worktree, có một đội agent riêng.
- 🤖 **Một đội CLI agent chính hãng đến từ nhiều nhà cung cấp.** Các agent chạy bằng gói đăng ký bạn đang có. Trong Facade Code, các agent khởi chạy lẫn nhau, nhắn tin cho nhau và gỡ rối cho nhau.
- 👥 **Super Engineer hoặc Super Team.** Tự mình chỉ huy nhiều agent, hoặc chỉ định một mô hình dẫn dắt để điều phối các chuyên gia làm việc song song.

## Cài đặt

Tải bản phát hành mới nhất từ [Releases](https://github.com/y5ez3g/facadecode/releases): tệp `.dmg` cho macOS (Apple silicon), trình cài đặt cho Windows (x64), hoặc tệp `.deb` cho Ubuntu (x64).

**Trước khi bắt đầu**: Cài đặt và đăng nhập vào các CLI agent bạn muốn dùng (kết hợp tùy ý Claude Code, Codex, Antigravity, Muse Code hoặc Qwen Code). Facade Code chạy trực tiếp chúng, dùng cơ chế xác thực và gói đăng ký riêng của từng CLI.

Facade Code được cài song song với VS Code và không dùng chung bất cứ thứ gì: cài đặt, tiện ích mở rộng và công cụ dòng lệnh `facade` đều hoàn toàn tách biệt.

## Bắt đầu nhanh

1. **Mở một dự án**:
   ```sh
   facade ~/code/space-shooter
   ```
   Hoặc dùng **File > Open Folder** (Tệp > Mở thư mục), hoặc kéo thả một thư mục vào thanh workspace. Thư mục phải là một git repository (worktree cần có git; hãy chạy `git init` trước nếu bạn bắt đầu từ đầu).

2. **Khởi chạy một tech lead**:
   Nhấp vào biểu tượng robot trên thanh tiêu đề (menu Agent), hoặc chạy **Agents: Start Agent...** (khởi chạy agent) trong Command Palette, rồi chọn Claude Code hoặc Codex. Agent được khởi chạy từ bên trong Facade Code sẽ có sẵn các công cụ MCP của Facade.

3. **Đưa cho nó prompt dành cho tech lead**:
   ```text
   Bạn là tech lead. Hãy dùng Facade để làm một game bắn súng không gian phong cách neon
   chạy trên trình duyệt (desktop) để demo, với một PD dùng GPT Sol 6 (gpt-6-sol, max)
   qua Codex, phụ trách giao diện và cảm giác chơi, và ba kỹ sư Muse 1.3
   (muse-spark-1.3, max) làm việc song song. Giữ quy mô nhỏ, khoảng nửa tiếng là xong:
   một màn chơi, ba loại kẻ địch, một trùm hai giai đoạn, vật phẩm tăng sức mạnh, điểm số
   và combo. Làm game hoàn chỉnh, chỉn chu quan trọng hơn thêm nhiều tính năng. Các kỹ sư tự merge
   phần việc của mình, bạn review sau. Gửi tôi một trang HTML gồm kế hoạch ngắn, một sơ đồ
   swimlane và bản mockup của PD, rồi chờ tôi duyệt trước khi bắt đầu.
   ```

4. **Xem cả đội cộng tác**:
   PD và các kỹ sư vừa được khởi chạy sẽ xuất hiện trên thanh workspace, dưới dự án và tính năng của họ. Khi bạn duyệt kế hoạch HTML, họ bắt đầu xây dựng. Bất cứ lúc nào bạn cũng có thể nhấp vào terminal của bất kỳ agent nào để xem đầu ra hoặc trò chuyện trực tiếp với nó.

*(Lưu ý: Prompt mẫu này khởi chạy 5 agent ở mức suy luận tối đa. Hãy điều chỉnh CLI, mô hình, mức suy luận và số lượng kỹ sư cho phù hợp với các gói đăng ký bạn đang có.)*

## Tính năng

### Dự án và tính năng, không phải phiên làm việc

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Hầu hết công cụ agent tạo một worktree cho mỗi phiên agent. Facade Code làm ngược lại: mỗi worktree là một tính năng, được liệt kê dưới repository của nó, và bạn là người giao agent vào đó.

Một tính năng thường cần nhiều hơn một agent. Agent viết code có thể không giải thích rõ công việc của mình hoặc không có con mắt thiết kế tốt, nên các agent khác giúp viết tài liệu, thiết kế và review, tất cả trong cùng một worktree. Agent đến rồi đi; tính năng vẫn ở lại.

- **Thanh workspace**: Liệt kê mọi repository và tính năng trong một cột. Nhấp vào một mục để chuyển cả cửa sổ (explorer, trình soạn thảo, terminal và quản lý mã nguồn), khôi phục đúng như lúc bạn rời đi. Các dự án không bao giờ lẫn vào nhau. Xem [`WORKSPACE.md`](../../facade-code-spec/WORKSPACE.md).
- **Vòng đời worktree**: **New Worktree** (worktree mới) tạo nhánh, đồng bộ các tệp cục bộ được liệt kê trong `.worktreeinclude` và chạy bước thiết lập. **Delete Worktree** (xóa worktree) cho biết chi tiết những gì sẽ mất trước khi xóa. Xem [`WORKTREE.md`](../../facade-code-spec/WORKTREE.md).
- **Tác vụ con song song**: Các tác vụ độc lập có thể tách ra thành các worktree riêng.

### Một đội đến từ mọi nhà cung cấp

- **CLI chính hãng trên gói đăng ký của bạn**: Claude Code, Codex, Muse Code, Antigravity và Qwen Code chạy trong terminal tích hợp riêng của chúng, dùng các gói đăng ký bạn đang có.
- **Agent khởi chạy agent**: Một agent có thể khởi chạy các agent khác (dùng CLI hoặc mô hình của bất kỳ nhà cung cấp nào) trong tính năng hiện tại hoặc trong một worktree mới, và giao việc cho chúng. Xem [`AGENT-LAUNCHER.md`](../../facade-code-spec/AGENT-LAUNCHER.md) và [`AGENT-ORCHESTRATION.md`](../../facade-code-spec/AGENT-ORCHESTRATION.md).
- **Nhắn tin**: Các agent nhắn tin cho nhau, báo cáo kết quả cho bên đã gọi chúng và thông báo cho bạn khi có quyết định cần con người phê duyệt. Xem [`AGENT-MESSAGES.md`](../../facade-code-spec/AGENT-MESSAGES.md).
- **Gỡ rối cho nhau**: Một agent có thể đọc terminal của agent khác, trả lời các câu hỏi của nó và gửi thao tác phím để giúp một agent đang bị kẹt mà không làm phiền bạn. Xem [`AGENT-DEBUGGING.md`](../../facade-code-spec/AGENT-DEBUGGING.md).
- **Bạn can thiệp được vào từng agent**: Mỗi agent có một dòng terminal riêng dưới tính năng của nó. Bạn thấy nó đang làm gì và có thể gõ trực tiếp vào đó bất cứ lúc nào.
- **MCP tiêu chuẩn**: Mọi công cụ điều phối đều được cung cấp qua một máy chủ MCP tiêu chuẩn.

## Hai cách làm việc

Sự chú ý của lập trình viên là điểm nghẽn. Hai chế độ này tương ứng với hai mức độ giao việc:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Vai trò của bạn** | Kỹ sư trực tiếp bắt tay vào việc | Quản lý kỹ thuật |
| **Bạn làm việc với ai** | Trực tiếp với nhiều agent | Một agent tech lead, 1:1 |
| **Ai điều phối các agent** | Bạn | Tech lead |
| **Phù hợp nhất cho** | Tính năng cần chỉ dẫn sát sao: công việc mang tính khám phá, quyết định thiết kế bạn muốn tự đánh giá, yêu cầu thay đổi liên tục | Tính năng lớn, được xác định rõ, chia nhỏ gọn gàng |

Bạn có thể kết hợp cả hai trong cùng một cửa sổ: giữ quyền kiểm soát chặt với các tính năng nhạy cảm, đồng thời giao công việc có phạm vi rõ ràng cho một tech lead.

- **Super Engineer**: Bạn mở worktree, giao việc cho agent ở nhiều repository khác nhau và review code ngay khi từng agent hoàn thành.
- **Super Team**: Bạn giao một tính năng cho một agent làm tech lead. Nó chia nhỏ công việc, định nghĩa các hợp đồng giao diện, khởi chạy các agent thực hiện và review kết quả của họ.
  - Một mô hình mạnh dẫn dắt; các mô hình nhanh hơn, rẻ hơn, chạy trên các gói đăng ký bạn đang có, triển khai song song; và các mô hình từ những nhà cung cấp khác nhau review công việc của nhau.
  - Chỉ cần một prompt là thiết lập được (xem [Bắt đầu nhanh](#bắt-đầu-nhanh)); các quy trình làm việc nhóm bạn dùng lại có thể viết thành skill.

*(README này cũng được viết theo cách đó: một agent phân tích, một agent soạn nháp, và một người đưa ra quyết định cuối cùng.)*

## Vì sao

Hầu hết công cụ lập trình bằng AI rơi vào hai nhóm: IDE kiểu Copilot, nơi con người phải theo dõi từng dòng, và Agent IDE, nơi việc review code và gỡ lỗi bị đẩy sang một trình soạn thảo bên ngoài. Không nhóm nào đưa được một đội agent chính hãng từ nhiều nhà cung cấp vào bên trong IDE chính của bạn.

Chúng tôi tin rằng tương lai là một lập trình viên dẫn dắt nhiều dự án và tính năng cùng một đội agent. Mỗi mô hình giỏi một kiểu việc khác nhau, nên đội cần gồm nhiều nhà cung cấp. Và vì agent viết code mà bạn review, đội ấy nên ở ngay trong IDE của bạn.

## Vẫn là VS Code

Facade Code chỉ thay đổi những gì cần thiết cho việc quản lý nhiều dự án và agent:

- **Thanh workspace** chiếm cột đầu tiên; **thanh hoạt động** chuyển lên góc trên bên phải của thanh tiêu đề (có thể khôi phục bằng `workbench.activityBar.location`).
- Copilot và chat của upstream bị tắt theo mặc định (chỉ cần một cài đặt để bật lại).
- Mọi thứ khác là VS Code nguyên bản: trình soạn thảo, cài đặt, phím tắt, `.vscode/` và các tệp `.code-workspace`.
- Tiện ích mở rộng được cài từ [Open VSX](https://open-vsx.org). Một số tiện ích độc quyền của Microsoft, như Remote Development và C/C++, chỉ được cấp phép cho các bản build chính thức của Microsoft và không thể chạy trên các bản fork.

## Build từ mã nguồn

Đưa [`facade-code-spec/RELEASE.md`](../../facade-code-spec/RELEASE.md) cho agent của bạn và để nó build.

Về hướng dẫn đóng góp và quy tắc nhánh, xem [`CONTRIBUTING.md`](CONTRIBUTING.md) và [`facade-code-spec/ENGINEERING.md`](../../facade-code-spec/ENGINEERING.md).

## Phản hồi

- **Lỗi và ý tưởng**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) hoặc **Help > Report Issue** (Trợ giúp > Báo cáo sự cố) trong trình soạn thảo.
- **Lỗ hổng bảo mật**: Vui lòng báo cáo riêng tư theo [`SECURITY.md`](SECURITY.md).

## Giấy phép

MIT, giống VS Code upstream. Xem [`LICENSE.txt`](../../LICENSE.txt) để biết thông báo bản quyền của Microsoft và thông báo của những người đóng góp cho Facade Code.
