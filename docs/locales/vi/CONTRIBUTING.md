# Đóng góp cho Facade Code

Cảm ơn bạn đã giúp đỡ. Facade Code được phát triển công khai tại [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Lỗi và ý tưởng

Hãy mở một [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Trợ giúp > Báo cáo sự cố) sẽ mở một issue mới với phiên bản của bạn đã được điền sẵn. Vui lòng tìm trong các issue hiện có trước, và nếu là lỗi, hãy cho biết:

- bạn đã làm gì, bạn mong đợi điều gì và điều gì đã thực sự xảy ra;
- phiên bản, xem trong Help > About (Trợ giúp > Giới thiệu), và hệ điều hành của bạn;
- nếu là sự cố với agent, đó là CLI agent nào và phiên bản nào.

Không báo cáo lỗ hổng bảo mật qua issue; xem [`SECURITY.md`](SECURITY.md).

## Code

Cách làm việc trong repository này được mô tả trong [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): cách thiết lập môi trường build, các lệnh kiểm tra một thay đổi, và toàn văn các quy tắc dưới đây.

- Tạo nhánh từ `main` với tên `feature/<number>-<name>`.
- Chỉ merge, không bao giờ rebase: một tính năng vào `main` bằng `--no-ff`, sau khi được review.
- Giữ các tệp của Facade Code ở cùng một chỗ, và trong các tệp của VS Code, hãy thêm hook tùy chọn thay vì viết lại logic của chúng, để việc merge một phiên bản VS Code mới hơn vẫn ít tốn công.
- Mỗi tính năng đều có công tắc; khi tắt tính năng, VS Code hoạt động như bản gốc.
- Mỗi thay đổi đều phải kèm test.
- Viết tài liệu, comment và commit message bằng tiếng Anh.

Mỗi tính năng cần làm gì được mô tả trong [`docs/ide/`](../../ide/). Để thay đổi hành vi, hãy bắt đầu từ đặc tả, hoặc mở một issue để thảo luận trước.

## Giấy phép

Khi đóng góp, bạn đồng ý rằng phần đóng góp của bạn được cấp phép theo [giấy phép MIT](../../../LICENSE.txt) của dự án.
