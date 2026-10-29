# 為 Facade Code 做出貢獻

感謝你的協助。Facade Code 在 [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode) 上公開開發。

## Bug 和建議

請開一個 [issue](https://github.com/y5ez3g/facadecode/issues)；在編輯器裡使用 Help > Report Issue（說明 > 回報問題）會開啟新的 issue，並自動填好你的版本。開之前請先搜尋現有的 issue。如果是 bug，請寫明：

- 你做了什麼、預期會怎樣、實際發生了什麼；
- 版本（在 Help > About（說明 > 關於）裡查看）和作業系統；
- 如果是 agent 的問題，是哪個 agent CLI、哪個版本。

安全性漏洞請不要在 issue 裡回報，請參閱 [`SECURITY.md`](SECURITY.md)。

## 程式碼

這個儲存庫的運作方式寫在 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md) 裡：如何設定建置環境、用哪些命令檢查變更，以及下列規則的完整版本。

- 從 `main` 建立分支，命名為 `feature/<number>-<name>`。
- 只用合併，不用 rebase：功能審查通過後，以 `--no-ff` 合併進 `main`。
- Facade Code 自己的檔案集中放在一起；在 VS Code 的檔案裡只加可選的掛鉤（hook），不改寫原本的邏輯，這樣日後合併新版 VS Code 的成本才會低。
- 每個功能都有開關，關閉時就是原本的 VS Code。
- 每個變更都要附上測試。
- 文件、註解和 commit 訊息一律使用英文。

每個功能應該做到什麼，寫在 [`docs/ide/`](../../ide/) 裡。要變更行為，請從規格文件著手，或先開一個 issue 討論。

## 授權

提交貢獻即表示你同意你的貢獻依本專案的 [MIT 授權條款](../../../LICENSE.txt)授權。
