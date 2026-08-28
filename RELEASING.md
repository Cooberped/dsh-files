# Release Process / 发布流程

This is the maintainer runbook for the Cooberped community fork of `dsh-files`.
It separates source integration, GitHub release, and npm publication so that a
successful build cannot publish externally without an explicit maintainer
decision.

本文是 Cooberped 社区 fork 的维护者发布手册。源码合并、GitHub Release 和 npm
发布是三个独立 Gate；测试通过不等于自动获得外部发布授权。

## Release authority / 发布权限

- Community contributors submit pull requests.
- Required checks run automatically.
- A human maintainer reviews and approves the change.
- GitHub auto-merge may merge an already-approved PR after all checks pass; it
  must never act as an automatic approval mechanism.
- Only a maintainer with release authority may create tags, GitHub releases, or
  npm publications.

社区贡献走 fork + PR；CI 自动检查，维护者人工审查。自动合并只执行已经批准的
合并决定。Tag、GitHub Release 和 npm 发布必须由有发布权限的维护者明确触发。

## One-time repository setup / 仓库一次性设置

Before the first public release, configure and verify:

- repository topics include `dsh-plugin`, `deepseek-harness`, `documents`, and
  relevant format tags so the plugin is discoverable;
- `main` requires a pull request, at least one approving review, required status
  checks, resolved conversations, and signed DCO commits;
- force pushes and branch deletion are blocked;
- CODEOWNERS review is required for security, release, dependency, and core
  runtime changes;
- squash merge is enabled; automatic branch deletion is recommended;
- GitHub Private Vulnerability Reporting is enabled;
- the release environment requires maintainer approval;
- npm trusted publishing/provenance is configured before tokenless publication;
- npm scope ownership is verified. Do not publish the unrelated, already-owned
  unscoped package name `dsh-files`; the intended scoped identity must match
  `package.json` and the verified npm account or organization.

## Release gates / 发布 Gate

All gates are fail-closed. Record the exact release commit SHA.

### 1. Source and provenance

- The release branch starts from current `main` and contains only reviewed
  changes.
- Upstream `taxueseek/dsh-files` history and MIT copyright notice remain intact.
- Every commit is DCO-signed; no CLA is required.
- `git status --short` is empty for tracked and non-ignored untracked files.
- No private documents, HR/customer data, credentials, absolute user paths,
  session stores, generated real-data indexes, or ad hoc local configuration
  are present.

### 2. Quality and security

Run the checks defined by the release candidate and record their output:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

- P0 and P1 findings are zero.
- Session isolation, path containment, upload limits, parser limits, and
  coordinate readback have focused coverage.
- A fresh independent review has no unresolved release-blocking finding.
- Private Vulnerability Reporting is visible to a logged-in, non-maintainer
  GitHub user and is manageable from a maintainer account.

### 3. License, dependencies, and assets

- Review the locked production dependency tree and
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Review `npm audit` as a signal; triage findings instead of hiding or blindly
  overriding them.
- Every shipped/readme asset is `CONFIRMED` in
  [assets/README.md](assets/README.md). `PENDING` is a release blocker: obtain
  provenance or remove/replace the asset and its references.
- Confirm project `LICENSE`, `THIRD_PARTY_NOTICES.md`, README files, and required
  runtime files are in the package.

### 4. Package inspection

Build once from the exact release candidate, then inspect the actual tarball:

```bash
pnpm build
npm pack --dry-run
npm pack
tar -tf *.tgz
```

Inspect for secrets, private data, local paths, unexpected dependency assets,
source maps containing private paths, and missing notices. Install that tarball
into a clean temporary Harness profile and run the documented smoke test.

### 5. Beta publication

Pre-1.0 changes are published as prereleases first. For example:

- Git tag: `v0.6.0-beta.1`
- GitHub Release: mark as **pre-release**
- npm dist-tag: `beta`, never implicit `latest`

Verify the candidate version does not already exist, then publish only after a
maintainer approval. Prefer trusted publishing with npm provenance. A local
fallback must use a short-lived, least-privilege npm credential and must never
commit or print the token.

```bash
npm publish --access public --tag beta
```

The command above is an operator action, not a CI test. Do not run it during
ordinary pull-request validation.

### 6. Post-publication verification

- Verify the GitHub tag resolves to the recorded release SHA.
- Verify npm name, version, `beta` dist-tag, provenance, package contents,
  repository link, license, and install command.
- Install from npm into a clean profile and run one upload, one search, and one
  coordinate read for the documented formats.
- Confirm no `latest` tag moved unintentionally.
- Publish checksums/evidence without user documents or secrets.

## Stable promotion / 稳定版晋级

Promote a beta to stable only after real daily-use feedback, no unresolved
P0/P1 issue, backward-compatibility review, and a new exact-SHA release gate.
Do not retag an existing tarball by assumption; verify its provenance and
contents first. Moving npm `latest` is a separate maintainer decision.

## Failed release / 发布失败

- Stop immediately on provenance, credential, privacy, license, or package-name
  ambiguity.
- Preserve the candidate and logs, redact secrets, and isolate the smallest
  failing step.
- Prefer publishing a corrected version and deprecating a broken version over
  relying on npm unpublish. Never replace artifacts under the same version.
- For a security incident, follow [SECURITY.md](SECURITY.md) and coordinate the
  advisory before public details.
