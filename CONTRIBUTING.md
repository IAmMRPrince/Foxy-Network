# Contributing to Foxy Network

Thanks for your interest! Issues, ideas and pull requests are welcome, in English or Spanish.

## Getting started

You need Node.js 20 or newer.

```bash
git clone https://github.com/IAmMRPrince/Foxy-Network.git
```

```bash
cd Foxy-Network
```

```bash
npm install
```

```bash
npm start
```

## Before opening a pull request

- Run the test suite. The contract tests need a local EVM, installed with `npm install --no-save ganache`; without it they are skipped.

  ```bash
  npm test
  ```

- Keep each pull request focused on one change, and add or update tests for what you change.
- Never commit secrets: anything under `.foxy/`, `.env` files, private keys or wallet files.
- Describe what changed and how you tested it.

## Where to start

- Issues labelled `good first issue`.
- The roadmap in the [README](README.md#roadmap).
- Documentation and translations.

## Security

Do not open public issues for vulnerabilities. Follow [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).
