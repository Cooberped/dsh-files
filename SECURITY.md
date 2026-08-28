# Security Policy / 安全策略

`dsh-files` handles local files and model-visible document content. Please use
coordinated disclosure and never test against another person's documents,
sessions, machine, or service without explicit permission.

`dsh-files` 会处理本地文件和可被模型读取的文档内容。请采用协调披露；未经明确
授权，不得在他人的文档、会话、设备或服务上测试漏洞。

## Supported versions / 支持版本

Before the first stable release, only the most recent published beta is
eligible for security fixes. If no beta has been published, there is no
supported public version. Older betas and unpublished local builds are not
supported. After a stable release, this table must be updated for every support
policy change.

| Version | Supported |
| --- | --- |
| Latest published beta | Yes / 是 |
| Older beta or local build | No / 否 |

## Reporting a vulnerability / 报告漏洞

1. **Preferred:** use GitHub Private Vulnerability Reporting at
   `https://github.com/Cooberped/dsh-files/security/advisories/new` when the
   repository has that feature enabled.
2. If that page is unavailable, do **not** open a public issue. Use a private
   contact method currently published on the `@Cooberped` GitHub profile and
   send only enough information to establish a private channel.
3. Do not send real documents, HR/customer data, credentials, tokens, absolute
   local paths, or session identifiers. Build a synthetic reproducer or agree
   on a secure transfer method first.

优先使用 GitHub Private Vulnerability Reporting。若该功能尚未开启，不要公开开
Issue；通过 `@Cooberped` GitHub 个人资料当前公开的私密联系渠道先建立联系。仓库
不假设或声明一个未经确认的安全邮箱。

Include, when safe:

- affected version and commit SHA;
- platform, Node.js version, and DeepSeek Harness version;
- impact and attack prerequisites;
- minimal, synthetic reproduction steps;
- whether session isolation, path containment, upload parsing, local storage,
  or model-visible content is involved;
- any proposed remediation or embargo constraints.

## Response process / 响应流程

Maintainers aim to acknowledge a report within five business days and provide
an initial assessment within ten business days. These are response goals, not a
service-level guarantee. The reporter and maintainers will coordinate on
validation, remediation, advisory text, CVE handling where appropriate, and a
disclosure date.

维护者会尽力在 5 个工作日内确认收到，并在 10 个工作日内给出初步判断；这是响应
目标，不是 SLA。修复发布前，请双方协调验证、公告内容和公开时间。

## Safe harbor / 善意研究

We support good-faith research that:

- stays within systems and data you own or are authorized to test;
- avoids privacy violations, persistence, destructive actions, and service
  disruption;
- stops and reports when sensitive data is encountered;
- gives maintainers reasonable time to remediate before disclosure;
- complies with applicable law.

This policy does not authorize testing of third-party infrastructure or data
and is not a waiver of applicable law.

## Public issues / 公开 Issue

After a fix is available, maintainers may publish a GitHub Security Advisory
and a minimal regression test that contains no exploit secrets or private data.
For non-sensitive hardening ideas, a normal public issue is welcome.
