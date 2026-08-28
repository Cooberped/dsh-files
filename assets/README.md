# Asset provenance register / 素材来源登记

Assets in this directory are inherited from the upstream
`taxueseek/dsh-files` history. Git history proves when they entered the
repository, but it does **not by itself prove** authorship of every screenshot,
permission for every visible UI/brand element, or absence of private data.

本目录素材继承自上游 `taxueseek/dsh-files`。Git 历史只能证明文件何时进入仓库，
不能单独证明截图作者、画面中 UI/品牌元素的公开使用权，也不能替代隐私检查。

## Status meanings / 状态定义

- `CONFIRMED`: source/capture owner, license or permission, privacy review, and
  confirmation date are recorded.
- `PENDING`: repository history exists, but one or more of those facts is not
  documented. This blocks a new public GitHub/npm release that includes or
  references the asset.
- `REJECTED`: must be removed or replaced before release.

`PENDING` 是发布阻断项。发布前必须补齐来源、许可、隐私检查、确认人和日期，或移除/
替换素材及 README 引用。不得仅因文件已存在于上游公开仓库就把状态改成 `CONFIRMED`。

## Current register / 当前登记

| Asset | SHA-256 | First recorded commit | Known fact | Status |
| --- | --- | --- | --- | --- |
| `readme/hero.svg` | `9dcc309978e0ae50e86988c13efca843ff0d0be9dcce4208976ff811745e1af1` | `888b9ea8e7d86ffdc0054afdbc88704133f6c187` | Added by upstream Git author `taxueseek`; external source/brand permission not documented | `PENDING` |
| `composer.png` | `656394140db9c7e065e2231b3a12076eee4ac50bc1d2d30597bbc19448db1d2f` | `0a2e483210b9be17e9bf8e875951f7252c68d767` | Added by upstream Git author `taxueseek`; capture owner, visible-data review, and UI permission not documented | `PENDING` |
| `upload-folder-images.png` | `147beafade2cfea0df5ab63a61fe9b82f9e76f93b49b01c9df03971538d67a43` | `73f1a42269ce04b3cca601e7e813b9a19a050050` | Added by upstream Git author `taxueseek`; capture owner, visible-data review, and UI permission not documented | `PENDING` |
| `native-image-dialog.png` | `8f10d12e36a6951a4deaa43ae0c1a96ac315d469f84e5a87738b00a09da10e2c` | `73f1a42269ce04b3cca601e7e813b9a19a050050` | Added by upstream Git author `taxueseek`; capture owner, visible-data review, and UI permission not documented | `PENDING` |
| `upload-entry.png` | `227680f76a74844b5a4fcb079c859eb3f547ba5cbfb0569ff58e0e4df7778583` | `a5d8d3452b6b9f00396ba976ca416d6f07acf78c` | Added by upstream Git author `taxueseek`; capture owner, visible-data review, and UI permission not documented | `PENDING` |

## Confirmation record / 确认记录

To change a row to `CONFIRMED`, add a dated record in the pull request and this
file containing:

1. creator or capture owner;
2. original source and creation/capture date, if known;
3. applicable license or explicit permission;
4. confirmation that no credential, private path, user document, personal data,
   or confidential model output is visible;
5. treatment of third-party trademarks and UI screenshots;
6. confirmer's GitHub identity and date.

New assets must enter this register in the same pull request that adds them.
