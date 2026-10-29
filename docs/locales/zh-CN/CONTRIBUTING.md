# 为 Facade Code 做贡献

感谢你的帮助。Facade Code 在 [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode) 上公开开发。

## Bug 和建议

请提交一个 [issue](https://github.com/y5ez3g/facadecode/issues)；在编辑器里用 Help > Report Issue（帮助 > 报告问题）会新建一个 issue，并自动填好你的版本号。提交前请先搜索已有的 issue。如果是 bug，请写明：

- 你做了什么，预期是什么，实际发生了什么；
- 版本号（在 Help > About（帮助 > 关于）里查看）和操作系统；
- 如果是 agent 的问题，用的是哪个 agent CLI、哪个版本。

安全漏洞不要在 issue 里报告，请参阅 [`SECURITY.md`](SECURITY.md)。

## 代码

这个仓库怎么运作，写在 [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md) 里：怎么搭好构建环境、用哪些命令检查改动，以及下面这些规则的完整版本。

- 从 `main` 拉分支，命名为 `feature/<number>-<name>`。
- 只合并，不 rebase：功能评审通过后，以 `--no-ff` 合并进 `main`。
- Facade Code 自己的文件放在一起；在 VS Code 的文件里只加可选的钩子，不改写原有逻辑，这样以后合并新版 VS Code 的成本才低。
- 每个功能都有开关，关掉就是原版 VS Code。
- 每个改动都要带测试。
- 文档、注释和提交信息一律使用英文。

每个功能应该做什么，写在 [`docs/ide/`](../../ide/) 里。要改动行为，请从规格文档入手，或者先开一个 issue 讨论。

## 许可证

提交贡献即表示你同意你的贡献按本项目的 [MIT 许可证](../../../LICENSE.txt)授权。
