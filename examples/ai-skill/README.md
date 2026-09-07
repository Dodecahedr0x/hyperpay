# HyperPay agent skill

Teaches an agent to set up a HyperPay signer, apply spend caps, open a payment
session (`initUser` / `openSession`), and let a merchant `charge`. The
instructions are in `SKILL.md`.

Install by copying this folder:

```sh
cp -R examples/ai-skill .cursor/skills/hyperpay          # Cursor, this repo
cp -R examples/ai-skill ~/.cursor/skills/hyperpay        # Cursor, all projects
cp -R examples/ai-skill .claude/skills/hyperpay          # Claude Code, this repo
```

No extra runtime — payments go through `@magicblock-labs/hyperpay`.

Contributing to this repo: [`AGENTS.md`](../../AGENTS.md). Full API surface:
[`docs/reference.md`](../../docs/reference.md).
