# 参与开发 / Contributing

工程规则以 [AGENTS.md](AGENTS.md) 为准；本文件只列上手必需的事项。

## 1. 构建前置依赖 / Build prerequisites

`better-sqlite3` 会在 `npm ci` / `npm install` 时由 `node-gyp` **从源码编译**，所以除了 Node.js ≥ 22.9，还需要 Python 3、`make` 和 C++ 编译器。缺少时安装会以 `gyp ERR! not ok` 失败。

`better-sqlite3` is compiled from source by `node-gyp` during install, so besides Node.js ≥ 22.9 you need Python 3, `make` and a C++ compiler.

| 平台 / Platform | 命令 / Command |
| --- | --- |
| Debian / Ubuntu | `sudo apt-get install -y python3 make g++` |
| Fedora / RHEL | `sudo dnf install -y python3 make gcc-c++` |
| Alpine | `apk add python3 make g++` |
| macOS | `xcode-select --install` |
| Windows | Visual Studio Build Tools（C++ 桌面开发）+ Python 3 |

然后：

```bash
npm ci
npm run dev
```

## 2. 每个 PR 必须通过 / Required checks (blocking)

与 CI（`.github/workflows/m0.yml`）一致：

```bash
npm run lint
npm run typecheck
npm test          # 全部 Vitest 单元 + 合约测试
npm run build
CI=1 npm run test:e2e   # 需要先 npx playwright install --with-deps chromium
```

## 3. 评测是仪表盘，不是门禁 / Evals are a dashboard, not a gate

见 [`docs/decisions/0005-eval-dashboard-not-gate.md`](docs/decisions/0005-eval-dashboard-not-gate.md)。

- **阻塞**：四条硬规则——原文与分歧前历史不被覆盖、证据可溯源、世界线隔离、坏输出被拒绝（fail closed）——以及上面的 CI 检查。
- **不阻塞**：召回率、修正成本、人工评分、真人观察等质量目标。`npm run eval:m1` 只把它们画在仪表盘上；改 Prompt 的 PR 附上一次仪表盘结果即可，未达标不阻止合并。
- 真人观察可选，作者自评是有效评分。
- 真实模型评测不进默认 CI；没有跑的话在 PR 里写明。

## 4. 不要提交 / Never commit

小说原文（私人 Benchmark 只放在被忽略的 `benchmarks/private/`）、`.env*`、密钥、`.data/`、数据库文件、raw model output。
