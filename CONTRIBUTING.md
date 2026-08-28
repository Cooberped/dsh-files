# Contributing to dsh-files / 参与 dsh-files 共建

Thank you for helping improve `dsh-files`. This repository is the
**Cooberped community fork** of [`taxueseek/dsh-files`](https://github.com/taxueseek/dsh-files).
We preserve the upstream Git history, attribution, and MIT notice while
maintaining an independent community release.

感谢你参与 `dsh-files`。本仓库是
[`taxueseek/dsh-files`](https://github.com/taxueseek/dsh-files) 的
**Cooberped 社区维护 fork**。我们保留上游 Git 历史、署名和 MIT 声明，并独立维护社区发行版。

## Before you start / 开始之前

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large feature, parser replacement, storage-format
  change, public API change, or security-sensitive refactor.
- Do not put private documents, HR data, credentials, API keys, session data,
  or customer data in issues, tests, fixtures, logs, screenshots, or commits.
- Reproduction files must be synthetic, minimal, and redistributable.
- Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public
  issue.

提交前请先检索现有 Issue/PR。大型功能、解析器替换、存储格式或公开接口变化、
安全敏感重构应先开 Issue 对齐。严禁提交真实业务文档、人力资源数据、凭据、API
密钥、会话数据或客户数据；复现文件必须是合成、最小且可再分发的材料。

## Development / 本地开发

Use the Node.js range declared in `package.json` and a Corepack-provided pnpm.
Do not regenerate the lockfile with an unrelated package manager.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

During development, run the smallest relevant test first. Before requesting
merge, run the repository checks affected by your change. Parser and retrieval
changes should include focused contract tests; UI changes should include a
targeted browser journey or reproducible manual evidence.

开发阶段优先运行与改动直接相关的 focused tests。请求合并前，再运行受影响的仓库
检查。解析和检索改动必须补充契约测试；UI 改动应提供 targeted browser journey
或可复现的人工证据。

Generated `lib/` files are tracked. If you change `src/`, run `pnpm build` and
include the matching generated output in the same pull request. Do not hand-edit
generated files.

## Scope and design expectations / 范围与设计要求

- Keep pull requests narrow and explain any user-visible behavior change.
- Preserve session isolation, path containment, upload limits, parser limits,
  and fail-closed behavior. A convenience change must not weaken them.
- Keep document coordinates stable (`page`, `slide`, `sheet`/`range`) and add a
  migration note before changing an indexed or persisted representation.
- Avoid adding a large runtime or external service when a smaller local solution
  meets the same contract.
- A dependency addition needs a reason, package-size impact, license review,
  maintenance assessment, and focused tests.
- Do not mix unrelated formatting, dependency, and behavior changes.

## Commit sign-off (DCO) / 提交签署（DCO）

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
and **does not require a Contributor License Agreement (CLA)**. Every commit
must contain a `Signed-off-by` trailer certifying that you have the right to
submit the contribution under this project's license:

```bash
git commit -s -m "feat: describe the change"
```

The trailer must use your real name and a reachable email identity:

```text
Signed-off-by: Example Contributor <contributor@example.com>
```

If a commit is missing the trailer, amend or rebase it; do not add another
person's sign-off. 贡献者无需签署 CLA，但每个 commit 都必须有本人 DCO sign-off，
用以确认你有权按本项目许可证提交该贡献。

## Pull-request process / PR 流程

1. Fork the repository and create a topic branch from current `main`.
2. Make a focused change with tests and documentation where relevant.
3. Confirm every commit has a DCO sign-off.
4. Complete the pull-request template, including exact validation commands.
5. Wait for required checks and a human maintainer review.
6. Address review comments with new commits; avoid force-pushing while a review
   is active unless the reviewer agrees.
7. A maintainer merges after approvals and required checks pass, normally using
   squash merge. GitHub auto-merge may execute that already-approved decision;
   it does not replace human approval.

社区贡献者通过 fork + PR 提交。CI 负责自动检查，维护者负责人工审查和最终合并。
自动合并只允许在人工批准、必需检查全部通过之后执行，不代表机器人自动批准代码。

Maintainers may close a pull request that is unsafe, out of scope, abandoned,
unlicensed, missing provenance, or impossible to validate. This is a technical
and stewardship decision, not a judgment of the contributor.

## Licensing and provenance / 许可证与来源

By submitting a contribution, you agree that your contribution is available
under the repository's [MIT License](LICENSE). Existing upstream copyright and
license notices must remain intact.

For copied or adapted code, fixtures, fonts, images, screenshots, or other
assets, identify the source and license in the pull request. Do not submit
material whose license is unknown or incompatible. Asset changes must also
update [assets/README.md](assets/README.md); dependency changes must update
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when applicable.

提交即表示你同意贡献按 MIT 许可证发布。必须保留既有上游版权与许可声明；任何复制
或改编的代码、fixture、字体、图片和截图都必须说明来源与许可证。

## Community conduct / 社区行为

All participation is subject to [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Be specific, evidence-led, and respectful when reporting defects or reviewing
another person's work.
